import { useEffect, useRef } from "react";

// One stem: static waveform (wavesurfer.js, peaks-only — no audio) + an
// imperatively-driven playhead overlay + volume / mute / solo controls.

function computePeaks(audioBuffer, buckets = 1200) {
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
  return peaks;
}

export default function StemTrack({
  name,
  buffer,
  settings,
  duration,
  onVolume,
  onMute,
  onSolo,
  onSeek,
  onPreview,
  registerTime,
}) {
  const containerRef = useRef(null);
  const wsRef = useRef(null);
  const playheadRef = useRef(null);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  // Create / recreate the wavesurfer instance when the buffer changes.
  useEffect(() => {
    let disposed = false;
    if (!buffer || !containerRef.current) return undefined;

    (async () => {
      const { default: WaveSurfer } = await import("wavesurfer.js");
      if (disposed || !containerRef.current) return;

      const peaks = computePeaks(buffer);
      const styles = getComputedStyle(document.documentElement);
      const ws = WaveSurfer.create({
        container: containerRef.current,
        height: 56,
        normalize: true,
        interact: false, // we handle seeking on the wrapper ourselves
        cursorWidth: 0,
        waveColor: styles.getPropertyValue("--wave").trim() || "#4a4a4a",
        progressColor: styles.getPropertyValue("--wave").trim() || "#4a4a4a",
        peaks: [peaks],
        duration: buffer.duration,
      });
      wsRef.current = ws;
    })();

    return () => {
      disposed = true;
      if (wsRef.current) {
        wsRef.current.destroy();
        wsRef.current = null;
      }
    };
  }, [buffer]);

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

  function timeFromEvent(e) {
    const d = durationRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    return frac * d;
  }
  function onWaveDown(e) {
    if (!durationRef.current) return;
    draggingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    onPreview(timeFromEvent(e));
  }
  function onWaveMove(e) {
    if (!draggingRef.current) return;
    onPreview(timeFromEvent(e));
  }
  function onWaveUp(e) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    onSeek(timeFromEvent(e)); // commit once, on release
  }

  const anySolo = settings.anySolo;
  const dimmed =
    (anySolo && !settings.solo) || (!anySolo && settings.muted);

  return (
    <div className={`stem ${dimmed ? "dimmed" : ""}`}>
      <div className="stem-label">{name}</div>

      <div
        className="wave-wrap"
        onPointerDown={onWaveDown}
        onPointerMove={onWaveMove}
        onPointerUp={onWaveUp}
        onPointerCancel={onWaveUp}
      >
        <div ref={containerRef} className="wave" />
        <div ref={playheadRef} className="playhead" />
      </div>

      <div className="stem-controls">
        <input
          className="vol"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={settings.volume}
          onChange={(e) => onVolume(name, parseFloat(e.target.value))}
          aria-label={`${name} volume`}
        />
        <button
          className={`tog ${settings.muted ? "on" : ""}`}
          onClick={() => onMute(name, !settings.muted)}
          title="Mute"
        >
          M
        </button>
        <button
          className={`tog ${settings.solo ? "on" : ""}`}
          onClick={() => onSolo(name, !settings.solo)}
          title="Solo"
        >
          S
        </button>
      </div>
    </div>
  );
}
