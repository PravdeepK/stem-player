import { useCallback, useEffect, useRef } from "react";
import { detentOnEndpoint } from "../lib/haptics";

// Shared per-stem logic, used by both presentations of a stem (the round pod
// and the original list row). Keeping it here means the two views can't drift
// apart, and — via PEAKS_CACHE below — that showing a stem twice doesn't cost
// twice the analysis.

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Peak extraction walks every sample, so it's the expensive part of mounting a
// waveform. Cache per AudioBuffer: both views of a stem share one result, and
// the entries disappear with the buffers when new stems are loaded.
const PEAKS_CACHE = new WeakMap();

function computePeaks(audioBuffer, buckets = 1200) {
  const cached = PEAKS_CACHE.get(audioBuffer);
  if (cached) return cached;

  const chCount = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const block = Math.max(1, Math.floor(len / buckets));
  const peaks = new Float32Array(buckets);
  const chans = [];
  for (let c = 0; c < chCount; c++) chans.push(audioBuffer.getChannelData(c));

  for (let i = 0; i < buckets; i++) {
    const start = i * block;
    let max = 0;
    for (let j = 0; j < block; j++) {
      const idx = start + j;
      if (idx >= len) break;
      let sum = 0;
      for (let c = 0; c < chCount; c++) sum += chans[c][idx];
      const v = Math.abs(sum / chCount);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }

  PEAKS_CACHE.set(audioBuffer, peaks);
  return peaks;
}

/**
 * Volume writes with an endpoint detent. Returns `applyVolume(next)`, which
 * clamps, skips no-op writes, and taps once when the value *arrives* at 0 or 1.
 */
export function useStemVolume(name, volume, onVolume) {
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  return useCallback(
    (next) => {
      const prev = volumeRef.current;
      const v = clamp01(next);
      if (v === prev) return;
      detentOnEndpoint(prev, v);
      volumeRef.current = v;
      onVolume(name, v);
    },
    [name, onVolume]
  );
}

/**
 * A static waveform plus an imperatively-driven playhead and pointer scrub.
 *
 * `colorVar` is a CSS custom property name resolved against the container, so
 * each view picks up whatever colour its own subtree defines.
 *
 * The returned `waveHandlers` must be spread onto the element that visually
 * owns the waveform — and that element must not be an ancestor of any other
 * drag target, or the two gestures will start together on one press.
 */
export function useStemWaveform({
  buffer,
  duration,
  height,
  colorVar,
  fallbackColor,
  onSeek,
  onPreview,
  registerTime,
}) {
  const containerRef = useRef(null);
  const playheadRef = useRef(null);
  const wsRef = useRef(null);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  useEffect(() => {
    let disposed = false;
    if (!buffer || !containerRef.current) return undefined;

    (async () => {
      const { default: WaveSurfer } = await import("wavesurfer.js");
      if (disposed || !containerRef.current) return;

      const peaks = computePeaks(buffer);
      const color =
        getComputedStyle(containerRef.current).getPropertyValue(colorVar).trim() ||
        fallbackColor;

      wsRef.current = WaveSurfer.create({
        container: containerRef.current,
        height,
        normalize: true,
        interact: false, // scrubbing is handled on the wrapper below
        cursorWidth: 0,
        waveColor: color,
        progressColor: color,
        peaks: [peaks],
        duration: buffer.duration,
      });
    })();

    return () => {
      disposed = true;
      if (wsRef.current) {
        wsRef.current.destroy();
        wsRef.current = null;
      }
    };
  }, [buffer, height, colorVar, fallbackColor]);

  // Imperative playhead — no React re-render per frame.
  useEffect(() => {
    if (!registerTime) return undefined;
    return registerTime((t) => {
      const el = playheadRef.current;
      const d = durationRef.current;
      if (!el || !d) return;
      el.style.left = `${Math.min(100, Math.max(0, (t / d) * 100))}%`;
    });
  }, [registerTime]);

  const draggingRef = useRef(false);

  const timeFromEvent = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    return frac * durationRef.current;
  };

  const onPointerDown = (e) => {
    if (!durationRef.current) return;
    draggingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    onPreview(timeFromEvent(e));
  };
  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    onPreview(timeFromEvent(e));
  };
  const onPointerUp = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    onSeek(timeFromEvent(e)); // commit once, on release
  };

  return {
    containerRef,
    playheadRef,
    waveHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}
