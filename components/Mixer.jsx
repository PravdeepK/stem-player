import { useEffect, useRef } from "react";
import { STEM_NAMES } from "../hooks/useAudioMixer";
import { tap } from "../lib/haptics";
import StemTrack from "./StemTrack";

// Four stem pods arranged around a shared transport hub, inside a circular
// shell. Grid positions are fixed per stem so the zones stay put:
//
//        vocals  ( hub )  drums
//        bass    ( hub )  instrumental
//
// The hub's outer arc shows track progress but is display-only — scrubbing
// lives on the linear seek bar and on each pod's waveform, as before.

const HUB_R = 46;
const HUB_C = 2 * Math.PI * HUB_R;

const ZONE_SLOT = {
  vocals: "nw",
  drums: "ne",
  bass: "sw",
  instrumental: "se",
};

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Mixer({ mixer, title }) {
  const {
    isLoaded,
    isPlaying,
    currentTime,
    duration,
    settings,
    buffers,
    play,
    pause,
    seek,
    previewTime,
    setVolume,
    setMute,
    setSolo,
    onTime,
  } = mixer;

  const seekBarRef = useRef(null);
  const seekFillRef = useRef(null);
  const hubArcRef = useRef(null);
  const seekDragRef = useRef(false);

  // Live seek fill + hub progress arc, driven imperatively so playback never
  // re-renders the tree.
  useEffect(() => {
    return onTime((t) => {
      const frac = duration ? Math.min(1, Math.max(0, t / duration)) : 0;
      const fill = seekFillRef.current;
      if (fill) fill.style.width = `${frac * 100}%`;
      const arc = hubArcRef.current;
      if (arc) arc.style.strokeDashoffset = `${HUB_C * (1 - frac)}`;
    });
  }, [onTime, duration]);

  if (!isLoaded || !buffers) return null;

  const anySolo = STEM_NAMES.some((n) => settings[n].solo);

  function fracFromEvent(e) {
    const el = seekBarRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function onSeekDown(e) {
    if (!duration) return;
    seekDragRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    previewTime(fracFromEvent(e) * duration);
  }
  function onSeekMove(e) {
    if (!seekDragRef.current || !duration) return;
    previewTime(fracFromEvent(e) * duration);
  }
  function onSeekUp(e) {
    if (!seekDragRef.current) return;
    seekDragRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    seek(fracFromEvent(e) * duration);
  }

  return (
    <section className="mixer">
      <div className="puck">
        {STEM_NAMES.map((name) => (
          <div key={name} className={`slot slot--${ZONE_SLOT[name]}`}>
            <StemTrack
              name={name}
              buffer={buffers[name]}
              duration={duration}
              settings={{ ...settings[name], anySolo }}
              onVolume={setVolume}
              onMute={setMute}
              onSolo={setSolo}
              onSeek={seek}
              onPreview={previewTime}
              registerTime={onTime}
            />
          </div>
        ))}

        <div className="hub">
          <svg className="hub-svg" viewBox="0 0 100 100" aria-hidden="true">
            <circle className="hub-track" cx="50" cy="50" r={HUB_R} />
            <circle
              ref={hubArcRef}
              className="hub-arc"
              cx="50"
              cy="50"
              r={HUB_R}
              strokeDasharray={HUB_C}
              strokeDashoffset={HUB_C}
              transform="rotate(-90 50 50)"
            />
          </svg>
          <div className="hub-face">
            <button
              className="hub-play"
              onClick={() => {
                tap();
                if (isPlaying) pause();
                else play();
              }}
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              <span className="hub-glyph">{isPlaying ? "❙❙" : "▶"}</span>
            </button>
            <div className="hub-time mono">
              {fmt(currentTime)} <span className="dim">/ {fmt(duration)}</span>
            </div>
          </div>
        </div>
      </div>

      <div
        className="seek"
        ref={seekBarRef}
        onPointerDown={onSeekDown}
        onPointerMove={onSeekMove}
        onPointerUp={onSeekUp}
        onPointerCancel={onSeekUp}
      >
        <div className="seek-track">
          <div ref={seekFillRef} className="seek-fill" />
        </div>
      </div>

      {title && <div className="mixer-title mono">{title}</div>}
    </section>
  );
}
