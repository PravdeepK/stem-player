import { useEffect, useRef, useState } from "react";
import { STEM_NAMES } from "../hooks/useAudioMixer";
import { detentOnEndpoint, tap } from "../lib/haptics";
import { VOLUME_REPEAT_MS, crossesMark, scrubPosition } from "../lib/holdScrub";

// The device as the app's main control surface. All the 3D lives in
// lib/deviceScene.js; this component only feeds it mixer state and maps the
// physical parts to mixer actions:
//
//   grooves  drag = stem volume · click = mute · hold the end = solo while held ·
//            double-click or Option-click = solo (lib/grooveGestures.js)
//   centre   play / pause
//   − / +    master volume · hold to keep stepping
//   dots     jump back / forward · hold to scrub (lib/holdScrub.js)
//   plain    open the menu
//
// Volume, hold-the-end solo, play/pause and − / + follow the hardware's manual;
// double-click and Option-click also solo, since a trackpad set to "tap to
// click" can't hold. The manual's
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
  Btn_Volume: ["Volume", "Click − or +, hold to keep going"],
  Btn_Dots: ["Skip Back / Forward", `${JUMP_SECONDS} seconds, hold to scrub`],
  Btn_Load: ["Menu"],
};
const GROOVE_HINT =
  "Drag for volume, click to mute, double-click to solo, hold the end to hear it alone";
// How long a confirmation ("Drums solo") replaces the hint.
const FLASH_MS = 1400;

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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
  const [flash, setFlash] = useState(null);
  const flashTimerRef = useRef(0);
  // What a held stem was before its hold-to-solo, to put back on release.
  const heldRef = useRef(null);
  // The pill being held, if any: its repeat timer, or its scrub's frame loop.
  const pillHoldRef = useRef(null);

  // A short confirmation of what just happened, in place of the hint.
  function showFlash(text) {
    clearTimeout(flashTimerRef.current);
    setFlash(text);
    flashTimerRef.current = setTimeout(() => setFlash(null), FLASH_MS);
  }
  useEffect(
    () => () => {
      clearTimeout(flashTimerRef.current);
      const hold = pillHoldRef.current;
      if (hold) {
        clearInterval(hold.timer);
        cancelAnimationFrame(hold.raf);
      }
    },
    []
  );

  useEffect(() => onTime((t) => (positionRef.current = t)), [onTime]);

  // The scene outlives every render, so its callbacks read the latest values here.
  const actionsRef = useRef(null);
  actionsRef.current = {
    togglePlay() {
      if (!isLoaded) return;
      tap();
      if (isPlaying) mixer.pause();
      else mixer.play();
      showFlash(isPlaying ? "Paused" : "Playing");
    },
    jump(direction) {
      if (!isLoaded) return;
      tap();
      mixer.seek(positionRef.current + direction * JUMP_SECONDS);
      showFlash(`${direction > 0 ? "Forward" : "Back"} ${JUMP_SECONDS} seconds`);
    },
    nudgeVolume(direction) {
      const next = Math.min(1, Math.max(0, masterVolume + direction * VOLUME_STEP));
      const rounded = Math.round(next * 100) / 100;
      if (rounded === masterVolume) return;
      tap();
      detentOnEndpoint(masterVolume, rounded);
      mixer.setMasterVolume(rounded);
      showFlash(`Volume ${Math.round(rounded * 100)}%`);
    },
    // A held − / + keeps stepping, starting straight away.
    holdStart(part, direction) {
      if (part === "Btn_Volume") {
        actionsRef.current.nudgeVolume(direction);
        pillHoldRef.current = {
          part,
          timer: setInterval(() => actionsRef.current.nudgeVolume(direction), VOLUME_REPEAT_MS),
        };
        return;
      }
      if (part !== "Btn_Dots" || !isLoaded) return;
      // A held dot scrubs the playhead; the song jumps there on release, as
      // with the waveform scrub. A tap marks every JUMP_SECONDS passed.
      tap();
      const hold = {
        part,
        direction,
        from: positionRef.current,
        pos: positionRef.current,
        duration: mixer.duration,
        startedAt: performance.now(),
        label: "",
        raf: 0,
      };
      const step = () => {
        const pos = scrubPosition(
          hold.from,
          direction,
          (performance.now() - hold.startedAt) / 1000,
          hold.duration
        );
        if (crossesMark(hold.pos, pos, JUMP_SECONDS)) tap();
        if (hold.duration > 0) detentOnEndpoint(hold.pos / hold.duration, pos / hold.duration);
        hold.pos = pos;
        mixer.previewTime(pos);
        const label = `${direction > 0 ? "Forward" : "Back"} to ${fmt(pos)}`;
        if (label !== hold.label) {
          hold.label = label;
          clearTimeout(flashTimerRef.current);
          setFlash(label);
        }
        hold.raf = requestAnimationFrame(step);
      };
      pillHoldRef.current = hold;
      step();
    },
    holdEnd(part) {
      const hold = pillHoldRef.current;
      pillHoldRef.current = null;
      if (!hold || hold.part !== part) return;
      clearInterval(hold.timer);
      cancelAnimationFrame(hold.raf);
      if (part === "Btn_Dots") {
        mixer.seek(hold.pos);
        showFlash(hold.label);
      }
    },
    load() {
      tap();
      onLoadPress();
    },
    toggleMute(stem) {
      if (!isLoaded) return;
      tap();
      const muted = !settings[stem].muted;
      mixer.setMute(stem, muted);
      showFlash(`${capitalize(stem)} ${muted ? "muted" : "unmuted"}`);
    },
    toggleSolo(stem) {
      if (!isLoaded) return;
      tap();
      const solo = !settings[stem].solo;
      mixer.setSolo(stem, solo);
      showFlash(`${capitalize(stem)} solo ${solo ? "on" : "off"}`);
    },
    holdSolo(stem) {
      if (!isLoaded) return;
      tap();
      const { muted, solo } = settings[stem];
      heldRef.current = { stem, muted, solo };
      if (!solo) mixer.setSolo(stem, true);
      clearTimeout(flashTimerRef.current);
      setFlash(`${capitalize(stem)} solo while held`);
    },
    releaseSolo(stem) {
      const before = heldRef.current;
      heldRef.current = null;
      if (!before || before.stem !== stem) return;
      if (before.muted) mixer.setMute(stem, true);
      else mixer.setSolo(stem, before.solo);
      setFlash(null);
    },
    drag(stem, volume) {
      if (!isLoaded) return;
      applyVolume(stem, volume);
      showFlash(`${capitalize(stem)} ${Math.round(Math.min(1, Math.max(0, volume)) * 100)}%`);
    },
    volumeOf: (stem) => settings[stem].volume,
  };

  useEffect(() => {
    let disposed = false;
    let handle = null;

    (async () => {
      try {
        const { createDeviceScene } = await import("../lib/deviceScene");
        const [bytes, doubleClickMs] = await Promise.all([
          window.api.readDeviceModel(),
          window.api.getDoubleClickInterval(),
        ]);
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
          onHoldStart: (part, side) => act().holdStart(part, side === "right" ? 1 : -1),
          onHoldEnd: (part) => act().holdEnd(part),
          onGrooveMute: (stem) => act().toggleMute(stem),
          onGrooveSolo: (stem) => act().toggleSolo(stem),
          onGrooveHoldStart: (stem) => act().holdSolo(stem),
          onGrooveHoldEnd: (stem) => act().releaseSolo(stem),
          onGrooveDrag: (stem, volume) => act().drag(stem, volume),
          getStemVolume: (stem) => act().volumeOf(stem),
          onHover: setHover,
          onTurned: (next) => {
            setTurned(next);
            if (next) setFlash(null);
          },
        }, { doubleClickMs });
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
  if (flash) caption = [flash];
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
