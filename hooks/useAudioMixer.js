import { useCallback, useEffect, useRef, useState } from "react";

// Canonical stem order. The loader always receives paths keyed by these names
// (legacy "other" is normalised to "instrumental" before it reaches here).
export const STEM_NAMES = ["vocals", "drums", "bass", "instrumental"];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function emptySettings() {
  const out = {};
  for (const n of STEM_NAMES) out[n] = { volume: 1, muted: false, solo: false };
  return out;
}

/**
 * Owns the Web Audio graph and transport for the 4 stems. The graph lives
 * entirely in refs; React state is a read-only mirror for rendering, so
 * re-renders never touch or restart playback.
 *
 * Graph: AudioBufferSourceNode (per stem, recreated per play/seek)
 *          -> GainNode (per stem, persistent)
 *          -> AudioContext.destination
 * Sync: all 4 sources are scheduled with a single shared `start(when, offset)`.
 */
export function useAudioMixer() {
  const ctxRef = useRef(null);
  const buffersRef = useRef({}); // name -> AudioBuffer
  const gainsRef = useRef({}); // name -> GainNode (persistent)
  const masterRef = useRef(null); // headroom bus: stem gains -> master -> destination
  const sourcesRef = useRef({}); // name -> AudioBufferSourceNode (per play)
  const startTimeRef = useRef(0); // ctx.currentTime when the current segment was scheduled
  const offsetRef = useRef(0); // track position (s) the current segment starts from
  const durationRef = useRef(0);
  const playingRef = useRef(false);
  const loadedRef = useRef(false);
  const stoppingRef = useRef(false); // true while we call source.stop() ourselves
  const scrubbingRef = useRef(false); // true while dragging a seek control
  const rafRef = useRef(0);
  const lastPushRef = useRef(0);
  const settingsRef = useRef(emptySettings());
  const timeListenersRef = useRef(new Set());
  const loadTokenRef = useRef(0); // guards against overlapping load() calls

  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(settingsRef.current);
  const [buffers, setBuffers] = useState(null); // name -> AudioBuffer, for waveforms

  const getCtx = () => {
    if (!ctxRef.current) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new Ctor();
    }
    return ctxRef.current;
  };

  const positionNow = () => {
    if (playingRef.current && ctxRef.current) {
      return offsetRef.current + (ctxRef.current.currentTime - startTimeRef.current);
    }
    return offsetRef.current;
  };

  const pushTime = (t) => {
    for (const cb of timeListenersRef.current) cb(t);
  };

  // Effective gain per stem given volume + mute + solo.
  const applyGains = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const s = settingsRef.current;
    const anySolo = STEM_NAMES.some((n) => s[n].solo);
    const t = ctx.currentTime;
    for (const n of STEM_NAMES) {
      const g = gainsRef.current[n];
      if (!g) continue;
      let v = s[n].volume;
      if (anySolo) v = s[n].solo ? v : 0;
      else if (s[n].muted) v = 0;
      // Smooth exponential glide (no click)...
      g.gain.setTargetAtTime(v, t, 0.012);
      // ...then, for a silenced stem, pin it to exactly 0 once the glide has
      // settled, so setTargetAtTime's asymptotic tail can't stay audible.
      if (v === 0) g.gain.setValueAtTime(0, t + 0.09);
    }
  };

  const stopSources = () => {
    stoppingRef.current = true;
    for (const src of Object.values(sourcesRef.current)) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* noop */
      }
    }
    sourcesRef.current = {};
    stoppingRef.current = false;
  };

  // Schedule all 4 sources from `offset`, sharing one start timestamp.
  const startSourcesAt = (offset) => {
    const ctx = getCtx();
    const when = ctx.currentTime + 0.06;
    const sources = {};
    for (const name of STEM_NAMES) {
      const buf = buffersRef.current[name];
      if (!buf) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gainsRef.current[name]);
      src.onended = () => {
        if (stoppingRef.current) return; // our own stop(), ignore
      };
      src.start(when, offset);
      sources[name] = src;
    }
    sourcesRef.current = sources;
    startTimeRef.current = when;
    offsetRef.current = offset;
  };

  const tick = useCallback(() => {
    const pos = positionNow();
    const clamped = clamp(pos, 0, durationRef.current);

    // While the user is dragging a seek control, let previewTime() own the
    // playhead visuals; the audio keeps playing underneath.
    if (!scrubbingRef.current) {
      pushTime(clamped);
      const now = performance.now();
      if (now - lastPushRef.current > 60) {
        lastPushRef.current = now;
        setCurrentTime(clamped);
      }
    }

    if (durationRef.current > 0 && pos >= durationRef.current) {
      stopSources();
      playingRef.current = false;
      offsetRef.current = 0;
      setIsPlaying(false);
      setCurrentTime(0);
      pushTime(0);
      rafRef.current = 0;
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const play = useCallback(async () => {
    if (!loadedRef.current || playingRef.current) return;
    scrubbingRef.current = false;
    const ctx = getCtx();
    if (ctx.state === "suspended") await ctx.resume();
    startSourcesAt(clamp(offsetRef.current, 0, durationRef.current));
    playingRef.current = true;
    setIsPlaying(true);
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const pause = useCallback(() => {
    if (!playingRef.current) return;
    scrubbingRef.current = false;
    const pos = clamp(positionNow(), 0, durationRef.current);
    stopSources();
    playingRef.current = false;
    offsetRef.current = pos;
    setIsPlaying(false);
    setCurrentTime(pos);
    pushTime(pos);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  const seek = useCallback((t) => {
    const target = clamp(t, 0, durationRef.current || 0);
    scrubbingRef.current = false;
    offsetRef.current = target;
    setCurrentTime(target);
    pushTime(target);
    if (playingRef.current) {
      stopSources();
      startSourcesAt(target);
    }
  }, []);

  // Move the playhead visuals + time readout without committing a seek — used
  // while dragging a seek control. Does not touch the transport; the running
  // tick loop yields the playhead to this until seek() commits.
  const previewTime = useCallback((t) => {
    scrubbingRef.current = true;
    const c = clamp(t, 0, durationRef.current || 0);
    pushTime(c);
    setCurrentTime(c);
  }, []);

  const updateStem = (name, patch) => {
    settingsRef.current = {
      ...settingsRef.current,
      [name]: { ...settingsRef.current[name], ...patch },
    };
    setSettings(settingsRef.current);
    applyGains();
  };
  const setVolume = useCallback((name, v) => updateStem(name, { volume: clamp(v, 0, 1) }), []);
  // Mute and solo are mutually exclusive per stem — turning one on clears the other.
  const setMute = useCallback(
    (name, muted) => updateStem(name, muted ? { muted: true, solo: false } : { muted: false }),
    []
  );
  const setSolo = useCallback(
    (name, solo) => updateStem(name, solo ? { solo: true, muted: false } : { solo: false }),
    []
  );

  const onTime = useCallback((cb) => {
    timeListenersRef.current.add(cb);
    cb(positionNow());
    return () => timeListenersRef.current.delete(cb);
  }, []);

  /**
   * THE single load path. Both entry points (auto-load after separation and
   * the "Load stems folder" button) call this with the same shape:
   *   { vocals, drums, bass, instrumental } -> absolute file paths
   */
  const load = useCallback(
    async (stemPaths) => {
      const token = ++loadTokenRef.current;
      setError("");
      setIsLoading(true);
      setIsLoaded(false);
      loadedRef.current = false;

      // Tear down current playback.
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      stopSources();
      playingRef.current = false;
      offsetRef.current = 0;
      setIsPlaying(false);
      setCurrentTime(0);
      pushTime(0);

      try {
        const ctx = getCtx();
        const entries = await Promise.all(
          STEM_NAMES.map(async (name) => {
            const p = stemPaths && stemPaths[name];
            if (!p) throw new Error(`missing stem path for "${name}"`);
            const arrayBuf = await window.api.readStemFile(p);
            const audioBuf = await ctx.decodeAudioData(arrayBuf);
            return [name, audioBuf];
          })
        );
        if (token !== loadTokenRef.current) return; // superseded by a newer load

        const nextBuffers = Object.fromEntries(entries);

        for (const g of Object.values(gainsRef.current)) {
          try {
            g.disconnect();
          } catch {
            /* noop */
          }
        }
        if (masterRef.current) {
          try {
            masterRef.current.disconnect();
          } catch {
            /* noop */
          }
        }
        // Master headroom bus: 4 stems reconstruct a near-0 dBFS master, so
        // summing them at unity clips on transients. Pull the bus down ~6 dB.
        const master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
        masterRef.current = master;

        const nextGains = {};
        for (const name of STEM_NAMES) {
          const g = ctx.createGain();
          g.gain.value = settingsRef.current[name].volume;
          g.connect(master);
          nextGains[name] = g;
        }

        buffersRef.current = nextBuffers;
        gainsRef.current = nextGains;
        const dur = Math.max(...STEM_NAMES.map((n) => nextBuffers[n].duration));
        durationRef.current = dur;

        setBuffers(nextBuffers);
        setDuration(dur);
        loadedRef.current = true;
        setIsLoaded(true);
        applyGains();
      } catch (err) {
        if (token !== loadTokenRef.current) return;
        console.error("[mixer] load failed:", err);
        setError("Couldn't load the stems for playback. See the console for details.");
        setIsLoaded(false);
        loadedRef.current = false;
      } finally {
        if (token === loadTokenRef.current) setIsLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      stopSources();
      if (ctxRef.current && ctxRef.current.state !== "closed") {
        ctxRef.current.close().catch(() => {});
      }
    };
  }, []);

  return {
    isLoaded,
    isLoading,
    isPlaying,
    currentTime,
    duration,
    error,
    settings,
    buffers,
    load,
    play,
    pause,
    seek,
    previewTime,
    setVolume,
    setMute,
    setSolo,
    onTime,
  };
}
