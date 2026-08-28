import { useEffect, useRef, useState } from "react";
import { useAudioMixer } from "../hooks/useAudioMixer";
import Mixer from "../components/Mixer";

// Phase 1: pick a file, run Demucs separation.
// Phase 2: load the 4 stems into a Web Audio mixer (play / seek / vol / mute / solo).

const STATES = {
  IDLE: "idle",
  PROCESSING: "processing",
  DONE: "done",
  ERROR: "error",
};

const STEM_ORDER = ["vocals", "drums", "bass", "instrumental"];

function basename(p) {
  if (!p) return "";
  return p.replace(/\/+$/, "").split("/").pop();
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
  const [outputBase, setOutputBase] = useState("");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null); // { stems, songDir, ... }
  const [errorMsg, setErrorMsg] = useState("");
  const [loadNote, setLoadNote] = useState("");
  const [mixerTitle, setMixerTitle] = useState("");
  // null = not yet checked, true/false = checked after mount (avoids SSR flash).
  const [hasApi, setHasApi] = useState(null);

  const procStartRef = useRef(0);
  const [nowTs, setNowTs] = useState(0);

  const mixer = useAudioMixer();

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

    window.api.getOutputBase().then((base) => setOutputBase(base || ""));

    const unsubscribe = window.api.onProgress((value) => {
      setProgress(typeof value === "number" ? value : 0);
    });
    return unsubscribe;
  }, []);

  async function handlePickFile() {
    if (!hasApi) return;
    const picked = await window.api.pickFile();
    if (!picked) return;
    setFilePath(picked);
    setErrorMsg("");
    setStatus(STATES.IDLE);
  }

  async function handleChangeFolder() {
    if (!hasApi) return;
    const picked = await window.api.pickFolder();
    if (!picked) return;
    setOutputBase(picked);
  }

  async function handleSeparate() {
    if (!hasApi || !filePath) return;

    const chosen = await window.api.pickFolder();
    if (!chosen) return;
    setOutputBase(chosen);

    procStartRef.current = Date.now();
    setNowTs(Date.now());
    setStatus(STATES.PROCESSING);
    setProgress(0);
    setResult(null);
    setErrorMsg("");
    setLoadNote("");

    const res = await window.api.separate(filePath, chosen);
    if (res && res.ok) {
      setResult(res);
      setStatus(STATES.DONE);
      setMixerTitle(basename(res.songDir));
      await mixer.load(res.stems); // <-- shared load path
    } else {
      setErrorMsg((res && res.message) || "Separation failed.");
      setStatus(STATES.ERROR);
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
    setMixerTitle(basename(r.dir));
    await mixer.load(r.stems); // <-- same shared load path
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

  return (
    <main className="wrap">
      <header className="head">
        <div className="title">STEM PLAYER</div>
        <div className="subtitle">Local separation · htdemucs_ft · CPU</div>
      </header>

      {hasApi === false && (
        <div className="banner danger">
          Electron bridge not available — run this inside the app, not a browser.
        </div>
      )}

      <section className="card">
        <div className="row">
          <span className="label">Source</span>
          <div className="value">
            {filePath ? (
              <span className="mono ellipsis" title={filePath}>
                {basename(filePath)}
              </span>
            ) : (
              <span className="dim">No file selected</span>
            )}
          </div>
          <button onClick={handlePickFile} disabled={busy}>
            {filePath ? "Change" : "Pick file…"}
          </button>
        </div>

        <div className="row">
          <span className="label">Output</span>
          <div className="value">
            {outputBase ? (
              <span className="mono ellipsis" title={outputBase}>
                {outputBase}
              </span>
            ) : (
              <span className="dim">Default (~/Music)</span>
            )}
          </div>
          <button onClick={handleChangeFolder} disabled={busy}>
            Change
          </button>
        </div>

        <p className="hint">
          Separation opens the folder picker so you can confirm or redirect.
          Output goes to <code>&lt;folder&gt;/&lt;song&gt;/stems/</code> with a
          copy of the original alongside. Or skip separation and load an existing
          stems folder straight into the mixer.
        </p>

        <div className="btn-row">
          <button
            className="primary go"
            onClick={handleSeparate}
            disabled={busy || !filePath}
          >
            {busy ? "Separating…" : "Separate"}
          </button>
          <button onClick={handleLoadStems} disabled={busy}>
            Load stems folder…
          </button>
        </div>
        {loadNote && <p className="err small">{loadNote}</p>}
      </section>

      <section className="card status">
        {status === STATES.IDLE && !mixer.isLoaded && (
          <div className="dim">Idle — ready.</div>
        )}

        {status === STATES.PROCESSING && (
          <div>
            <div className="statusline">
              <span className="pill running">Processing</span>
              <span className="mono">{pct}%</span>
            </div>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="dim small" style={{ marginTop: 8 }}>
              {fmtDur(elapsedSec)} elapsed
              {etaSec != null
                ? ` · ~${fmtDur(etaSec)} left`
                : " · estimating…"}
            </div>
          </div>
        )}

        {status === STATES.ERROR && (
          <div>
            <span className="pill danger">Failed</span>
            <p className="err">{errorMsg}</p>
            <p className="dim small">
              Underlying error logged to the console / DevTools.
            </p>
          </div>
        )}

        {status === STATES.DONE && result && (
          <div>
            <div className="statusline">
              <span className="pill ok">Separated</span>
              <button
                className="link"
                onClick={() => window.api && window.api.showItem(result.songDir)}
              >
                Show in Finder
              </button>
            </div>
            <div className="path-block mono" title={result.songDir}>
              {result.songDir}
            </div>
          </div>
        )}

        {mixer.isLoading && (
          <div className="statusline">
            <span className="pill running">Loading stems…</span>
          </div>
        )}
        {mixer.error && <p className="err">{mixer.error}</p>}
      </section>

      {mixer.isLoaded && <Mixer mixer={mixer} title={mixerTitle} />}
    </main>
  );
}
