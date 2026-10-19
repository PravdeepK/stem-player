import { tap } from "../lib/haptics";
import { useStemVolume, useStemWaveform } from "../hooks/useStemControls";

// The original list-style presentation of a stem: label, full-width waveform,
// then volume / mute / solo. Kept alongside the pod view — both read and write
// the same mixer settings, so they stay in sync automatically.

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
  const applyVolume = useStemVolume(name, settings.volume, onVolume);
  const { containerRef, playheadRef, waveHandlers } = useStemWaveform({
    buffer,
    duration,
    height: 56,
    colorVar: "--wave",
    fallbackColor: "#4a4a4a",
    onSeek,
    onPreview,
    registerTime,
  });

  const anySolo = settings.anySolo;
  const dimmed = (anySolo && !settings.solo) || (!anySolo && settings.muted);

  return (
    <div className={`stem ${dimmed ? "dimmed" : ""}`}>
      <div className="stem-label">{name}</div>

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
          onChange={(e) => applyVolume(parseFloat(e.target.value))}
          aria-label={`${name} volume`}
        />
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
    </div>
  );
}
