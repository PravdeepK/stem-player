import { tap } from "../lib/haptics";
import { useStemWaveform } from "../hooks/useStemControls";

// One stem's waveform, level readout and scrub. The real device has no screen,
// so this is where a stem's detail lives; volume, mute and solo are played on
// the device itself. The range and M/S controls here are keyboard-only, and
// become visible if the 3D device couldn't load (.stems--fallback).

export default function StemRow({
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
  const { containerRef, playheadRef, waveHandlers } = useStemWaveform({
    buffer,
    duration,
    height: 72,
    colorVar: "--zone",
    fallbackColor: "#4a4a4a",
    onSeek,
    onPreview,
    registerTime,
  });

  const anySolo = settings.anySolo;
  const dimmed = (anySolo && !settings.solo) || (!anySolo && settings.muted);
  const status = settings.solo ? "solo" : settings.muted ? "muted" : "";

  return (
    <div className={`stem stem--${name} ${dimmed ? "dimmed" : ""}`}>
      <div className="stem-head">
        <span className="stem-dot" aria-hidden="true" />
        <span className="stem-label">{name}</span>
        {status && <span className="stem-status mono">{status}</span>}
        <span className="stem-value mono">{Math.round(settings.volume * 100)}</span>
      </div>

      <div className="wave-wrap" {...waveHandlers}>
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
          onClick={() => {
            tap();
            onMute(name, !settings.muted);
          }}
          aria-label={`Mute ${name}`}
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
          aria-label={`Solo ${name}`}
          aria-pressed={settings.solo}
        >
          S
        </button>
      </div>
    </div>
  );
}
