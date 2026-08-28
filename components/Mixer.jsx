import { useEffect, useRef, useState } from "react";
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
    setVolume,
    setMute,
    setSolo,
    onTime,
  } = mixer;

  // Live playhead for the global seek bar, updated imperatively.
  const seekFillRef = useRef(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);

  useEffect(() => {
    return onTime((t) => {
      const el = seekFillRef.current;
      if (el && duration) el.style.width = `${(t / duration) * 100}%`;
    });
  }, [onTime, duration]);

  // While dragging the seek bar, move the fill live (no transport tick fires).
  function previewScrub(v) {
    setScrubValue(v);
    const el = seekFillRef.current;
    if (el && duration) el.style.width = `${(v / duration) * 100}%`;
  }

  if (!isLoaded || !buffers) return null;

  const anySolo = STEM_NAMES.some((n) => settings[n].solo);
  const displayTime = scrubbing ? scrubValue : currentTime;

  return (
    <section className="mixer">
      <div className="transport">
        <button className="play primary" onClick={isPlaying ? pause : play}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        <span className="time mono">
          {fmt(displayTime)} / {fmt(duration)}
        </span>
      </div>

      <div className="seek">
        <div className="seek-track">
          <div ref={seekFillRef} className="seek-fill" />
        </div>
        <input
          className="seek-input"
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={scrubbing ? scrubValue : Math.min(currentTime, duration || 0)}
          onMouseDown={() => setScrubbing(true)}
          onChange={(e) => previewScrub(parseFloat(e.target.value))}
          onMouseUp={(e) => {
            setScrubbing(false);
            seek(parseFloat(e.target.value));
          }}
          aria-label="Seek"
        />
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
            registerTime={onTime}
          />
        ))}
      </div>
    </section>
  );
}
