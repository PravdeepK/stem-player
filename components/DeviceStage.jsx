import { useEffect, useRef, useState } from "react";
import { STEM_NAMES } from "../hooks/useAudioMixer";
import { detentOnEndpoint, tap } from "../lib/haptics";

// The device as the app's main control surface. All the 3D lives in
// lib/deviceScene.js; this component only feeds it mixer state and maps the
// physical parts to mixer actions:
//
//   grooves  drag = stem volume · hold the outer end = solo · tap = mute
//   centre   play / pause
//   − / +    master volume
//   dots     jump back / forward
//   plain    open the menu
//
// Volume, solo, play/pause and − / + follow the hardware's manual. The manual's
// next/previous (dots) and loop menu (plain) have no equivalent here, and the
// device has no mute at all, so those are this app's own.
//
// Every part also has a hidden button or range input for keyboard access. They
// only show while focused, and pulse the matching part so focus has a visible
// effect on the device.

const JUMP_SECONDS = 10;
const VOLUME_STEP = 0.1;

// One short hint at a time: what's under the pointer, or else whatever is most
// useful right now. Mac wording: click, not tap.
const PART_HINTS = {
  Btn_Center: ["Play/Pause"],
  Btn_Volume: ["Volume", "Click − or +"],
  Btn_Dots: ["Skip Back / Forward", `${JUMP_SECONDS} seconds`],
  Btn_Load: ["Menu"],
};
const GROOVE_HINT = "Drag to change the volume, click to mute, hold the end to solo";

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function ledLevels(settings, isLoaded) {
  const anySolo = STEM_NAMES.some((n) => settings[n].solo);
  const levels = {};
  for (const name of STEM_NAMES) {
    const { volume, muted, solo } = settings[name];
    const quiet = anySolo ? !solo : muted;
    levels[name] = { volume, glow: !isLoaded ? 0 : quiet ? 0.1 : 1 };
  }
  return levels;
}

export default function DeviceStage({ mixer, busy, applyVolume, onLoadPress, onUnavailable }) {
  const { isLoaded, isPlaying, settings, masterVolume, onTime } = mixer;

  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const positionRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState(null);
  const [turned, setTurned] = useState(false);

  useEffect(() => onTime((t) => (positionRef.current = t)), [onTime]);

  // The scene outlives every render, so its callbacks read the latest values here.
  const actionsRef = useRef(null);
  actionsRef.current = {
    togglePlay() {
      if (!isLoaded) return;
      tap();
      if (isPlaying) mixer.pause();
      else mixer.play();
    },
    jump(direction) {
      if (!isLoaded) return;
      tap();
      mixer.seek(positionRef.current + direction * JUMP_SECONDS);
    },
    nudgeVolume(direction) {
      const next = Math.min(1, Math.max(0, masterVolume + direction * VOLUME_STEP));
      const rounded = Math.round(next * 100) / 100;
      if (rounded === masterVolume) return;
      tap();
      detentOnEndpoint(masterVolume, rounded);
      mixer.setMasterVolume(rounded);
    },
    load() {
      tap();
      onLoadPress();
    },
    toggleMute(stem) {
      if (!isLoaded) return;
      tap();
      mixer.setMute(stem, !settings[stem].muted);
    },
    toggleSolo(stem) {
      if (!isLoaded) return;
      tap();
      mixer.setSolo(stem, !settings[stem].solo);
    },
    drag(stem, volume) {
      if (isLoaded) applyVolume(stem, volume);
    },
    volumeOf: (stem) => settings[stem].volume,
  };

  useEffect(() => {
    let disposed = false;
    let handle = null;

    (async () => {
      try {
        const { createDeviceScene } = await import("../lib/deviceScene");
        const bytes = await window.api.readDeviceModel();
        if (disposed) return;

        const css = getComputedStyle(document.documentElement);
        const stemColors = Object.fromEntries(
          STEM_NAMES.map((n) => [n, css.getPropertyValue(`--zone-${n}`).trim()])
        );
        const act = () => actionsRef.current;
        const scene = await createDeviceScene(canvasRef.current, bytes, stemColors, {
          onTap(part, side) {
            const direction = side === "right" ? 1 : -1;
            if (part === "Btn_Center") act().togglePlay();
            else if (part === "Btn_Dots") act().jump(direction);
            else if (part === "Btn_Volume") act().nudgeVolume(direction);
            else if (part === "Btn_Load") act().load();
          },
          onGrooveTap: (stem) => act().toggleMute(stem),
          onGrooveHold: (stem) => act().toggleSolo(stem),
          onGrooveDrag: (stem, volume) => act().drag(stem, volume),
          getStemVolume: (stem) => act().volumeOf(stem),
          onHover: setHover,
          onTurned: setTurned,
        });
        if (disposed) {
          scene.dispose();
          return;
        }
        handle = scene;
        sceneRef.current = scene;
        setReady(true);
      } catch (err) {
        if (disposed) return;
        console.error("[device] scene failed:", err);
        setFailed(true);
        onUnavailable();
      }
    })();

    return () => {
      disposed = true;
      sceneRef.current = null;
      if (handle) handle.dispose();
    };
  }, [onUnavailable]);

  useEffect(() => {
    if (ready) sceneRef.current.setLevels(ledLevels(settings, isLoaded));
  }, [ready, settings, isLoaded]);

  const pressed = (part, fn) => () => {
    if (sceneRef.current) sceneRef.current.pulse(part);
    fn();
  };
  const act = actionsRef.current;

  let caption = [isLoaded ? "Drag a groove to change a stem’s volume" : ""];
  if (!isLoaded && !busy) caption = ["Open the menu to load a song"];
  if (turned) caption = ["Double-click the background to reset"];
  if (hover) caption = STEM_NAMES.includes(hover) ? [capitalize(hover), GROOVE_HINT] : PART_HINTS[hover];
  const [captionTitle, captionDetail] = caption;

  return (
    <div className="stage">
      <canvas ref={canvasRef} className="stage-canvas" aria-hidden="true" />

      <div className="stage-caption" aria-live="polite">
        {failed ? (
          "Couldn’t load the 3D player. Its controls are in the menu."
        ) : (
          <>
            {captionTitle}
            {captionDetail && <span className="dim"> {captionDetail}</span>}
          </>
        )}
      </div>

      <div className="kbd-controls">
        <button onClick={pressed("Btn_Center", act.togglePlay)}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button onClick={pressed("Btn_Dots", () => act.jump(-1))}>
          Back {JUMP_SECONDS} seconds
        </button>
        <button onClick={pressed("Btn_Dots", () => act.jump(1))}>
          Forward {JUMP_SECONDS} seconds
        </button>
        <button onClick={pressed("Btn_Volume", () => act.nudgeVolume(-1))}>Volume down</button>
        <button onClick={pressed("Btn_Volume", () => act.nudgeVolume(1))}>Volume up</button>
      </div>
    </div>
  );
}
