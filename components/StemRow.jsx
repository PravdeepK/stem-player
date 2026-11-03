import { useEffect, useRef } from "react";
import { tap } from "../lib/haptics";
import { useStemWaveform } from "../hooks/useStemControls";

// One stem's waveform, level readout and scrub. The real device has no screen,
// so this is where a stem's detail lives; volume, mute and solo are played on
// the device itself. The range and M/S controls here are keyboard-only, and
// become visible if the 3D device couldn't load (.stems--fallback).
//
// The dot and waveform can bounce with the stem's live level (`bounce`), written
// straight to the DOM each frame like the playhead. Nothing moves while the menu
// is closed, and Reduce Motion keeps it still.

// How far each style stretches at full level.
const BOUNCE = {
  dot: { dot: 0.8, wave: 0 },
  wave: { dot: 0, wave: 0.3 },
  both: { dot: 0.8, wave: 0.12 },
};
// Levels jump up at once and fall back gently, like a meter.
const RELEASE = 0.18;

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
  onLevels,
  bounce,
  active,
}) {
  const { containerRef, playheadRef, waveHandlers } = useStemWaveform({
    buffer,
    duration,
    height: 52,
    colorVar: "--zone",
    fallbackColor: "#4a4a4a",
    onSeek,
    onPreview,
    registerTime,
  });

  const dotRef = useRef(null);
  const bounceRef = useRef(bounce);
  const activeRef = useRef(active);
  bounceRef.current = bounce;
  activeRef.current = active;

  useEffect(() => {
    if (!onLevels) return undefined;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let shown = 0;
    return onLevels((levels, stopped) => {
      const target = levels[name] || 0;
      if (stopped) shown = 0;
      else shown = target > shown ? target : shown + (target - shown) * RELEASE;
      const dot = dotRef.current;
      const wave = containerRef.current;
      if (!dot || !wave) return;
      // Hidden or still: back to rest, so nothing reappears mid-bounce.
      const amount =
        reduceMotion.matches || !activeRef.current ? null : BOUNCE[bounceRef.current];
      dot.style.transform = amount ? `scale(${1 + amount.dot * shown})` : "";
      dot.style.boxShadow =
        amount && amount.dot ? `0 0 ${10 * shown}px ${2 * shown}px var(--zone)` : "";
      wave.style.transform = amount ? `scaleY(${1 + amount.wave * shown})` : "";
    });
  }, [onLevels, name, containerRef]);

  const anySolo = settings.anySolo;
  const dimmed = (anySolo && !settings.solo) || (!anySolo && settings.muted);
  const status = settings.solo ? "solo" : settings.muted ? "muted" : "";

  return (
    <div className={`stem stem--${name} ${dimmed ? "dimmed" : ""}`}>
      <div className="stem-head">
        <span ref={dotRef} className="stem-dot" aria-hidden="true" />
        <span className="stem-label">{name}</span>
        {status && <span className="stem-status">{status}</span>}
        <span className="stem-value">{Math.round(settings.volume * 100)}</span>
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
