import { useEffect, useRef } from "react";
import { STEM_NAMES } from "../hooks/useAudioMixer";
import StemTrack from "./StemTrack";

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
  const draggingRef = useRef(false);

  // Live seek-bar fill, driven imperatively so playback doesn't re-render it.
  useEffect(() => {
    return onTime((t) => {
      const el = seekFillRef.current;
      if (el && duration) el.style.width = `${(t / duration) * 100}%`;
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
    draggingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    previewTime(fracFromEvent(e) * duration);
  }
  function onSeekMove(e) {
    if (!draggingRef.current || !duration) return;
    previewTime(fracFromEvent(e) * duration);
  }
  function onSeekUp(e) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    seek(fracFromEvent(e) * duration);
  }

  return (
    <section className="mixer">
      <div className="transport">
        <button className="play primary" onClick={isPlaying ? pause : play}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        <span className="time mono">
          {fmt(currentTime)} / {fmt(duration)}
        </span>
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

      <div className="stems">
        {STEM_NAMES.map((name) => (
          <StemTrack
            key={name}
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
        ))}
      </div>
    </section>
  );
}
