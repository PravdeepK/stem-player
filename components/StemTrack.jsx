import { useRef } from "react";
import { tap } from "../lib/haptics";
import { useStemVolume, useStemWaveform } from "../hooks/useStemControls";

// One stem as a circular "pod": a drag-to-set volume ring, mute / solo
// toggles, and a waveform strip with pointer-driven scrub.
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
  const applyVolume = useStemVolume(name, settings.volume, onVolume);
  const { containerRef, playheadRef, waveHandlers } = useStemWaveform({
    buffer,
    duration,
    height: 40,
    colorVar: "--zone",
    fallbackColor: "#4a4a4a",
    onSeek,
    onPreview,
    registerTime,
  });

  // --- volume ring drag (owns .pod-ring) --------------------------------
  const ringDragRef = useRef(null); // { startY, startVolume } while dragging

  function onRingDown(e) {
    ringDragRef.current = { startY: e.clientY, startVolume: settings.volume };
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
          <div className="pod-pct mono">{Math.round(settings.volume * 100)}</div>
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

      <div className="wave-wrap" {...waveHandlers}>
        <div ref={containerRef} className="wave" />
        <div ref={playheadRef} className="playhead" />
      </div>
    </div>
  );
}
