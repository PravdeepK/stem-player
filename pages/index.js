import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioMixer } from "../hooks/useAudioMixer";
import { useBeatTaps } from "../hooks/useBeatTaps";
import Mixer from "../components/Mixer";
import { PROCESSORS, QUALITY, canSeparate, chipName, recommend } from "../lib/recommend";

// Phase 1: pick a file, run Demucs separation.
// Phase 2: load the 4 stems into a Web Audio mixer (play / seek / vol / mute / solo).
// Phase 3: the 3D device is the whole screen; loading and waveforms live in a
// slide-out menu, opened from the hamburger or the device's plain edge button.
// Separated songs go in a private cache (electron/stemCache.js), so the user
// never manages folders; Export is the only thing that writes outside it.

const STATES = {
  IDLE: "idle",
  PROCESSING: "processing",
  ERROR: "error",
};

// The corner meter's style is a per-viewer convenience, so it lives in localStorage.
const METER_STYLES = [
  ["dots", "Dots"],
  ["wave", "Waveform"],
  ["off", "Off"],
];
const METER_STORAGE_KEY = "stem-player.meter-style";

// Beat taps are off until turned on: constant ticking isn't for everyone.
const BEAT_TAPS_STORAGE_KEY = "stem-player.beat-taps";

function basename(p) {
  if (!p) return "";
  return p.replace(/\/+$/, "").split("/").pop();
}

function shortPath(p) {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return `/${parts.join("/")}`;
  return `…/${parts.slice(-2).join("/")}`;
}

// A picked stems/ folder is named after its contents; the song is its parent.
function songTitle(dir) {
  const name = basename(dir);
  if (name.toLowerCase() !== "stems") return name;
  return basename(dir.replace(/\/+$/, "").slice(0, -name.length)) || name;
}

function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

export default function Home() {
  const [status, setStatus] = useState(STATES.IDLE);
  const [filePath, setFilePath] = useState(null);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [loadNote, setLoadNote] = useState("");
  const [song, setSong] = useState(null); // { title, stems, id? } now in the mixer
  const [recents, setRecents] = useState([]);
  const [exported, setExported] = useState(null); // folder of the last export
  const [exportNote, setExportNote] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [model, setModel] = useState("htdemucs");
  const [processor, setProcessor] = useState("gpu");
  const [mac, setMac] = useState(null); // system profile, null until probed
  const [fellBack, setFellBack] = useState(false);
  // What the progress bar is following: "starting" | "engine" | "model" | "separating".
  const [stage, setStage] = useState("starting");
  const [meterStyle, setMeterStyle] = useState("dots");
  const [beatTaps, setBeatTaps] = useState(false);
  // "on" | "off" | "none" | "unknown", null until checked.
  const [haptics, setHaptics] = useState(null);
  // null = not yet checked, true/false = checked after mount (avoids SSR flash).
  const [hasApi, setHasApi] = useState(null);

  const procStartRef = useRef(0);
  const [nowTs, setNowTs] = useState(0);

  const mixer = useAudioMixer();
  useBeatTaps(mixer, beatTaps);

  const toggleMenu = useCallback(() => setMenuOpen((open) => !open), []);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Tick once a second while separating so the ETA counts down between the
  // (coarser) progress updates from the Python subprocess.
  useEffect(() => {
    if (status !== STATES.PROCESSING) return undefined;
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  useEffect(() => {
    const available = typeof window !== "undefined" && !!window.api;
    setHasApi(available);
    if (!available) return;

    window.api.getModel().then((m) => m && setModel(m));
    window.api.getSystemProfile().then((profile) => {
      setMac(profile);
      if (!canSeparate(profile)) return;
      const preferred = profile.savedProcessor || recommend(profile).processor;
      setProcessor(profile.gpuSupported ? preferred : "cpu");
    });
    window.api.listRecent().then(setRecents);

    // Checked again on every return to the window, so turning the setting on
    // in System Settings shows up as soon as the user comes back.
    const checkHaptics = () => window.api.getHapticsStatus().then(setHaptics);
    checkHaptics();
    window.addEventListener("focus", checkHaptics);

    const offProgress = window.api.onProgress((value) => {
      setProgress(typeof value === "number" ? value : 0);
    });
    // Each stage, and the CPU starting over, has a bar of its own, so its time
    // is counted from its own start.
    const restartClock = () => {
      procStartRef.current = Date.now();
      setNowTs(Date.now());
    };
    const offStage = window.api.onStage((next) => {
      setStage(next);
      setProgress(0);
      restartClock();
    });
    const offFallback = window.api.onFallback(() => {
      setFellBack(true);
      setStage("starting");
      setProgress(0);
      restartClock();
    });
    return () => {
      window.removeEventListener("focus", checkHaptics);
      offProgress();
      offStage();
      offFallback();
    };
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(METER_STORAGE_KEY);
      if (METER_STYLES.some(([id]) => id === saved)) setMeterStyle(saved);
      if (localStorage.getItem(BEAT_TAPS_STORAGE_KEY) === "on") setBeatTaps(true);
    } catch {
      /* storage unavailable: keep the default */
    }
  }, []);

  function chooseMeterStyle(next) {
    setMeterStyle(next);
    try {
      localStorage.setItem(METER_STORAGE_KEY, next);
    } catch {
      /* not remembered this time */
    }
  }

  function chooseBeatTaps(next) {
    setBeatTaps(next);
    try {
      localStorage.setItem(BEAT_TAPS_STORAGE_KEY, next ? "on" : "off");
    } catch {
      /* not remembered this time */
    }
  }

  async function openSong(next) {
    setSong(next);
    setExported(null);
    setExportNote("");
    setLoadNote("");
    await mixer.load(next.stems); // <-- the shared load path, for every source
    setMenuOpen(false);
    setRecents(await window.api.listRecent());
  }

  async function handlePickFile() {
    if (!hasApi) return;
    const picked = await window.api.pickFile();
    if (!picked) return;
    setFilePath(picked);
    setErrorMsg("");
    setStatus(STATES.IDLE);
    const cached = await window.api.findCached(picked, model);
    if (cached) await openSong(cached);
  }

  async function handleSeparate() {
    if (!hasApi || !filePath) return;

    procStartRef.current = Date.now();
    setNowTs(Date.now());
    setStatus(STATES.PROCESSING);
    setStage("starting");
    setProgress(0);
    setFellBack(false);
    setErrorMsg("");
    setLoadNote("");

    const res = await window.api.separate(filePath, model, processor);
    if (res && res.ok) {
      setStatus(STATES.IDLE);
      await openSong(res.entry);
    } else {
      setErrorMsg((res && res.message) || "Separation failed.");
      setStatus(STATES.ERROR);
      setMenuOpen(true);
    }
  }

  async function handleOpenRecent(id) {
    const entry = await window.api.openRecent(id);
    if (entry) {
      await openSong(entry);
    } else {
      setLoadNote("That song is no longer saved. Separate it again.");
      setRecents(await window.api.listRecent());
    }
  }

  async function handleLoadStems() {
    if (!hasApi) return;
    setLoadNote("");
    const r = await window.api.pickStemsFolder();
    if (!r || r.canceled) return;
    if (!r.ok) {
      setLoadNote(r.message || "Couldn't load that folder.");
      return;
    }
    await openSong({ title: songTitle(r.dir), stems: r.stems });
  }

  async function handleExport() {
    if (!song) return;
    setExportNote("");
    const r = await window.api.exportStems(song.stems, song.title);
    if (r.ok) setExported(r.dir);
    else if (!r.canceled) setExportNote(r.message);
  }

  const busy = status === STATES.PROCESSING;
  const pct = Math.round(progress * 100);

  const elapsedSec =
    busy && procStartRef.current
      ? Math.max(0, (nowTs - procStartRef.current) / 1000)
      : 0;
  let etaSec =
    progress > 0.05 && elapsedSec > 2
      ? (elapsedSec * (1 - progress)) / progress
      : null;
  if (etaSec != null && etaSec >= 30) etaSec = Math.round(etaSec / 5) * 5;
  const timing = `${fmtDur(elapsedSec)} elapsed${
    etaSec != null ? ` · ~${fmtDur(etaSec)} left` : " · estimating…"
  }`;

  const qualityOf = (m) => QUALITY.find((q) => q.model === m);
  const supported = !mac || canSeparate(mac);
  const rec = mac && supported && recommend(mac);

  // The bar's label, and a note on why it's there. Downloads read the same on
  // the main screen; separating names the song there.
  const STAGES = {
    starting: ["Getting ready…", ""],
    engine: ["Downloading the stem engine…", "A one-time download before your first song. "],
    model: [
      `Downloading the ${qualityOf(model)?.label} model…`,
      "Each quality setting downloads its model the first time it's used. ",
    ],
    separating: ["Separating…", ""],
  };
  const [stageLabel, stageNote] = STAGES[stage] || STAGES.starting;

  let activity = "";
  if (busy) activity = `${stage === "separating" ? `Separating “${basename(filePath)}”…` : stageLabel} ${pct}%`;
  else if (mixer.isLoading) activity = "Loading stems…";

  // Settings-style groups: a label on the left, its control on the right, and
  // at most one short footnote per group.
  let footnote = "";
  if (mac && supported) {
    const chip = chipName(mac.chip);
    if (!mac.gpuSupported) footnote = `Stems are made on the CPU, since the GPU on your ${chip} isn't available.`;
    else if (model === rec.model && processor === rec.processor) footnote = `Recommended for your ${chip}.`;
    else if (model === "htdemucs_ft") footnote = "Best is cleaner, but takes about four times as long.";
    else footnote = "The CPU is slower than the GPU, and makes the same stems.";
  }

  const menu = (
    <>
      <header className="head">
        <h1 className="title">Stem Player</h1>
      </header>

      {hasApi === false && (
        <div className="banner danger">
          Electron bridge not available — run this inside the app, not a browser.
        </div>
      )}

      {supported ? (
        <section className="section">
          <div className="group">
            <div className="group-row">
              <span className="row-label">Song</span>
              <span className="row-value" title={filePath || ""}>
                {filePath ? basename(filePath) : <span className="dim">None</span>}
              </span>
              <button className="choose" onClick={handlePickFile} disabled={busy || !hasApi}>
                Choose…
              </button>
            </div>
            <div className="group-row">
              <span className="row-label">Quality</span>
              <div className="segmented" role="radiogroup" aria-label="Quality">
                {QUALITY.map((q) => (
                  <button
                    key={q.model}
                    role="radio"
                    aria-checked={model === q.model}
                    className={model === q.model ? "on" : ""}
                    disabled={busy}
                    onClick={() => setModel(q.model)}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
            {mac && mac.gpuSupported && (
              <div className="group-row">
                <span className="row-label">Processor</span>
                <div className="segmented" role="radiogroup" aria-label="Processor">
                  {PROCESSORS.map((p) => (
                    <button
                      key={p.id}
                      role="radio"
                      aria-checked={processor === p.id}
                      className={processor === p.id ? "on" : ""}
                      disabled={busy}
                      onClick={() => setProcessor(p.id)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          {footnote && <p className="footnote">{footnote}</p>}

          {busy ? (
            <div className="progress" role="status">
              <div className="progress-line">
                <span>{stageLabel}</span>
                <span className="dim">{pct}%</span>
              </div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <p className="footnote">
                {fellBack ? "The GPU had a problem, so the CPU is finishing this song. " : ""}
                {stageNote}
                {timing}
              </p>
            </div>
          ) : (
            <button className="primary go" onClick={handleSeparate} disabled={!filePath}>
              Separate
            </button>
          )}

          {fellBack && !busy && status !== STATES.ERROR && (
            <p className="footnote">The last song finished on the CPU after a GPU problem.</p>
          )}
          {status === STATES.ERROR && <p className="err">{errorMsg}</p>}
        </section>
      ) : (
        <section className="section">
          <p className="unsupported">
            Making stems needs a Mac with Apple silicon. You can still open stems you
            already have.
          </p>
        </section>
      )}

      {recents.length > 0 && (
        <section className="section">
          <h2 className="section-title">Recent</h2>
          <div className="group">
            {recents.map((r) => (
              <button
                key={r.id}
                className="group-row recent"
                disabled={busy}
                aria-current={song && song.id === r.id ? "true" : undefined}
                onClick={() => handleOpenRecent(r.id)}
              >
                <span className="row-value">{r.title}</span>
                <span className="dim recent-quality">{qualityOf(r.model)?.label}</span>
              </button>
            ))}
          </div>
          <p className="footnote">Older songs are removed automatically. Export a song to keep it.</p>
        </section>
      )}

      <section className="section">
        <h2 className="section-title">Main Screen</h2>
        <div className="group">
          <div className="group-row">
            <span className="row-label">Level Meter</span>
            <div className="segmented" role="radiogroup" aria-label="Level meter style">
              {METER_STYLES.map(([id, label]) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={meterStyle === id}
                  className={meterStyle === id ? "on" : ""}
                  onClick={() => chooseMeterStyle(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="footnote">
          {meterStyle === "off"
            ? "The level meter is hidden."
            : "Shows each stem’s level in the top-right corner while a song plays."}
        </p>
      </section>

      <section className="section">
        <h2 className="section-title">Haptics</h2>
        <div className="group">
          <div className="group-row">
            <span className="row-label">Trackpad</span>
            <span className="row-value">
              {haptics === "on" && "Ready"}
              {haptics === "off" && "Taps are off"}
              {haptics === "none" && <span className="dim">No Force Touch trackpad</span>}
              {(haptics === null || haptics === "unknown") && <span className="dim">—</span>}
            </span>
            {haptics === "off" && (
              <button className="choose" onClick={() => window.api.openTrackpadSettings()}>
                Turn On…
              </button>
            )}
          </div>
          <div className="group-row">
            <span className="row-label">Beat Taps</span>
            <div className="segmented" role="radiogroup" aria-label="Beat taps">
              {[
                [false, "Off"],
                [true, "On"],
              ].map(([on, label]) => (
                <button
                  key={label}
                  role="radio"
                  aria-checked={beatTaps === on}
                  className={beatTaps === on ? "on" : ""}
                  onClick={() => chooseBeatTaps(on)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {haptics === "off" ? (
          <p className="footnote">
            Taps are off because Force Click and haptic feedback is turned off in System
            Settings › Trackpad. Turn it on there to feel the device under your finger.
          </p>
        ) : haptics === "none" ? (
          <p className="footnote">
            Taps need a MacBook trackpad or a Magic Trackpad 2 or later. With a mouse, the
            device works the same, just without the taps.
          </p>
        ) : (
          <p className="footnote">
            Taps the trackpad on each drum hit, or on the soloed stem. Turning the volume
            down lets only the harder hits through. Needs a finger resting on the trackpad.
          </p>
        )}
      </section>

      <section className="section">
        <button className="secondary" onClick={handleLoadStems} disabled={busy || !hasApi}>
          Open Stems Folder…
        </button>
        {loadNote && <p className="err">{loadNote}</p>}
        {mixer.error && <p className="err">{mixer.error}</p>}
      </section>
    </>
  );

  const stemsActions = (
    <>
      <div className="stems-head">
        <h2 className="section-title">Stems</h2>
        <button className="secondary small" onClick={handleExport}>
          Export Stems…
        </button>
      </div>
      {exported && (
        <div className="notice">
          <span title={exported}>Exported to {shortPath(exported)}</span>
          <button className="link" onClick={() => window.api.showItem(exported)}>
            Show in Finder
          </button>
        </div>
      )}
      {exportNote && <p className="err">{exportNote}</p>}
    </>
  );

  return (
    <main className="wrap">
      <Mixer
        mixer={mixer}
        title={song ? song.title : ""}
        activity={activity}
        menu={menu}
        stemsActions={stemsActions}
        meterStyle={meterStyle}
        hapticsOff={haptics === "off"}
        menuOpen={menuOpen}
        onMenuToggle={toggleMenu}
        onMenuOpen={openMenu}
        onMenuClose={closeMenu}
      />
    </main>
  );
}
