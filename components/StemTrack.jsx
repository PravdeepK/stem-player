import { useEffect, useRef } from "react";
import { detentOnEndpoint, tap } from "../lib/haptics";

// One stem, presented as a circular "pod": a drag-to-set volume ring, mute /
// solo toggles, and a waveform strip with pointer-driven scrub.
//
// POINTER LAYOUT — deliberate, don't collapse it:
// `.pod-ring` and `.wave-wrap` are SIBLINGS, and `.pod` itself carries no
// pointer handlers at all. Two drag interactions this close together will
// fight if either one hangs off a shared ancestor: a press on the waveform
// would bubble up and start a volume drag at the same time as a scrub. Keeping
// them siblings makes that impossible structurally rather than by convention.
// Each drag owns its own ref and captures on its own element, so once a
// gesture starts it can't hand off to the other by moving across it.

const RING_R = 44;
const RING_C = 2 * Math.PI * RING_R;
// Vertical travel (px) that spans the full 0..1 volume range.
const RING_DRAG_PX = 150;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

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

  const volumeRef = useRef(settings.volume);
  volumeRef.current = settings.volume;

  // Create / recreate the wavesurfer instance when the buffer changes.
  useEffect(() => {
    let disposed = false;
    if (!buffer || !containerRef.current) return undefined;

    (async () => {
      const { default: WaveSurfer } = await import("wavesurfer.js");
      if (disposed || !containerRef.current) return;

      const peaks = computePeaks(buffer);
      // --zone is set per-pod in CSS and inherits down to the container, so
      // each stem's waveform picks up its own zone colour.
      const zone =
        getComputedStyle(containerRef.current).getPropertyValue("--zone").trim() ||
        "#4a4a4a";
      const ws = WaveSurfer.create({
        container: containerRef.current,
        height: 40,
        normalize: true,
        interact: false, // we handle seeking on the wrapper ourselves
        cursorWidth: 0,
        waveColor: zone,
        progressColor: zone,
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

  // --- waveform scrub (owns .wave-wrap) ---------------------------------
  const waveDragRef = useRef(false);

  function timeFromEvent(e) {
    const d = durationRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    return frac * d;
  }
  function onWaveDown(e) {
    if (!durationRef.current) return;
    waveDragRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    onPreview(timeFromEvent(e));
  }
  function onWaveMove(e) {
    if (!waveDragRef.current) return;
    onPreview(timeFromEvent(e));
  }
  function onWaveUp(e) {
    if (!waveDragRef.current) return;
    waveDragRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    onSeek(timeFromEvent(e)); // commit once, on release
  }

  // --- volume ring drag (owns .pod-ring) --------------------------------
  const ringDragRef = useRef(null); // { startY, startVolume } while dragging

  function applyVolume(next) {
    const prev = volumeRef.current;
    const v = clamp01(next);
    if (v === prev) return;
    detentOnEndpoint(prev, v);
    volumeRef.current = v;
    onVolume(name, v);
  }

  function onRingDown(e) {
    ringDragRef.current = { startY: e.clientY, startVolume: volumeRef.current };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  }
  function onRingMove(e) {
    const drag = ringDragRef.current;
    if (!drag) return;
    // Up raises. Pointer capture keeps this gesture on the ring even when the
    // cursor travels down over the waveform strip.
    const delta = (drag.startY - e.clientY) / RING_DRAG_PX;
    applyVolume(drag.startVolume + delta);
  }
  function onRingUp(e) {
    if (!ringDragRef.current) return;
    ringDragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  }

  const anySolo = settings.anySolo;
  const dimmed = (anySolo && !settings.solo) || (!anySolo && settings.muted);
  const pct = Math.round(settings.volume * 100);

  return (
    <div className={`pod pod--${name} ${dimmed ? "dimmed" : ""}`}>
      <div
        className="pod-ring"
        onPointerDown={onRingDown}
        onPointerMove={onRingMove}
        onPointerUp={onRingUp}
        onPointerCancel={onRingUp}
      >
        <svg className="ring-svg" viewBox="0 0 100 100" aria-hidden="true">
          <circle className="ring-track" cx="50" cy="50" r={RING_R} />
          <circle
            className="ring-value"
            cx="50"
            cy="50"
            r={RING_R}
            strokeDasharray={`${settings.volume * RING_C} ${RING_C}`}
            transform="rotate(-90 50 50)"
          />
        </svg>

        <div className="pod-face">
          <div className="pod-name">{name}</div>
          <div className="pod-pct mono">{pct}</div>
        </div>

        {/* Backing control for keyboard + screen readers. Pointer-inert (see
            .pod-vol in globals.css) so it can never swallow the ring drag. */}
        <input
          className="pod-vol"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={settings.volume}
          onChange={(e) => applyVolume(parseFloat(e.target.value))}
          aria-label={`${name} volume`}
        />
      </div>

      <div className="pod-toggles">
        <button
          className={`tog ${settings.muted ? "on" : ""}`}
          onClick={() => {
            tap();
            onMute(name, !settings.muted);
          }}
          title="Mute"
          aria-pressed={settings.muted}
        >
          M
        </button>
        <button
          className={`tog ${settings.solo ? "on" : ""}`}
          onClick={() => {
            tap();
            onSolo(name, !settings.solo);
          }}
          title="Solo"
          aria-pressed={settings.solo}
        >
          S
        </button>
      </div>

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
    </div>
  );
}
