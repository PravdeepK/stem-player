import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioMixer } from "../hooks/useAudioMixer";
import Mixer from "../components/Mixer";

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

const QUALITY = [
  { model: "htdemucs", label: "Fast" },
  { model: "htdemucs_ft", label: "Best", note: "about 4× slower" },
];

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
  // null = not yet checked, true/false = checked after mount (avoids SSR flash).
  const [hasApi, setHasApi] = useState(null);

  const procStartRef = useRef(0);
  const [nowTs, setNowTs] = useState(0);

  const mixer = useAudioMixer();

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
    window.api.listRecent().then(setRecents);

    const unsubscribe = window.api.onProgress((value) => {
      setProgress(typeof value === "number" ? value : 0);
    });
    return unsubscribe;
  }, []);

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
    setProgress(0);
    setErrorMsg("");
    setLoadNote("");

    const res = await window.api.separate(filePath, model);
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

  let activity = "";
  if (busy) activity = `Separating ${basename(filePath)} · ${pct}%`;
  else if (mixer.isLoading) activity = "Loading stems…";

  const menu = (
    <>
      <header className="head">
        <div className="title">STEM PLAYER</div>
        <div className="subtitle">Local separation · Demucs · CPU</div>
      </header>

      {hasApi === false && (
        <div className="banner danger">
          Electron bridge not available — run this inside the app, not a browser.
        </div>
      )}

      <section className="card">
        <div className="field">
          <span className="field-label">Song</span>
          {filePath ? (
            <div className="field-row">
              <span className="field-value" title={filePath}>
                {basename(filePath)}
              </span>
              <button onClick={handlePickFile} disabled={busy}>
                Change
              </button>
            </div>
          ) : (
            <button className="pick" onClick={handlePickFile} disabled={!hasApi}>
              Choose a song…
            </button>
          )}
        </div>

        <div className="field">
          <span className="field-label">Quality</span>
          <div className="quality" role="radiogroup" aria-label="Quality">
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
          {qualityOf(model)?.note && <p className="field-note">{qualityOf(model).note}</p>}
        </div>

        {busy ? (
          <div className="progress" role="status">
            <div className="progress-line">
              <span>Separating…</span>
              <span className="mono">{pct}%</span>
            </div>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="field-note">{timing}. You can close this menu.</p>
          </div>
        ) : (
          <button className="primary go" onClick={handleSeparate} disabled={!filePath}>
            Separate
          </button>
        )}

        {status === STATES.ERROR && <p className="err">{errorMsg}</p>}
      </section>

      {recents.length > 0 && (
        <section className="recents">
          <div className="field-label">Recent songs</div>
          {recents.map((r) => (
            <button
              key={r.id}
              className="recent"
              disabled={busy}
              aria-current={song && song.id === r.id ? "true" : undefined}
              onClick={() => handleOpenRecent(r.id)}
            >
              <span className="recent-title">{r.title}</span>
              <span className="recent-quality mono">{qualityOf(r.model)?.label}</span>
            </button>
          ))}
          <p className="field-note">
            Older songs are removed automatically. Export a song to keep it.
          </p>
        </section>
      )}

      <button className="link open-stems" onClick={handleLoadStems} disabled={busy || !hasApi}>
        Open stems folder…
      </button>
      {loadNote && <p className="err">{loadNote}</p>}
      {mixer.error && <p className="err">{mixer.error}</p>}
    </>
  );

  const stemsActions = (
    <>
      <div className="stems-head">
        <span className="field-label">Stems</span>
        <button className="link" onClick={handleExport}>
          Export stems
        </button>
      </div>
      {exported && (
        <div className="notice">
          <span title={exported}>Saved to {shortPath(exported)}</span>
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
        menuOpen={menuOpen}
        onMenuToggle={toggleMenu}
        onMenuOpen={openMenu}
        onMenuClose={closeMenu}
      />
    </main>
  );
}
