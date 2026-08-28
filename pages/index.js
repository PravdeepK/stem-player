import { useEffect, useState } from "react";

// Phase 1 UI: pick a file, pick/confirm an output folder, run Demucs
// separation, show progress, list stems. Light styling for demo purposes only.

const STATES = {
  IDLE: "idle",
  PROCESSING: "processing",
  DONE: "done",
  ERROR: "error",
};

const STEM_ORDER = ["vocals", "drums", "bass", "instrumental"];

function basename(p) {
  if (!p) return "";
  return p.split("/").pop();
}

export default function Home() {
  const [status, setStatus] = useState(STATES.IDLE);
  const [filePath, setFilePath] = useState(null);
  const [outputBase, setOutputBase] = useState("");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null); // { stems, songDir, stemsDir, originalCopy }
  const [errorMsg, setErrorMsg] = useState("");
  // null = not yet checked, true/false = checked after mount (avoids SSR flash).
  const [hasApi, setHasApi] = useState(null);

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
    setResult(null);
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

    // "Pick once, confirm each run": open the folder picker pre-pointed at the
    // remembered base. Cancelling aborts the run.
    const chosen = await window.api.pickFolder();
    if (!chosen) return;
    setOutputBase(chosen);

    setStatus(STATES.PROCESSING);
    setProgress(0);
    setResult(null);
    setErrorMsg("");

    const res = await window.api.separate(filePath, chosen);
    if (res && res.ok) {
      setResult(res);
      setStatus(STATES.DONE);
    } else {
      setErrorMsg((res && res.message) || "Separation failed.");
      setStatus(STATES.ERROR);
    }
  }

  const busy = status === STATES.PROCESSING;
  const pct = Math.round(progress * 100);

  return (
    <main className="wrap">
      <header className="head">
        <div className="title">STEM PLAYER</div>
        <div className="subtitle">Local separation · htdemucs · CPU</div>
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
          copy of the original alongside.
        </p>

        <button
          className="primary go"
          onClick={handleSeparate}
          disabled={busy || !filePath}
        >
          {busy ? "Separating…" : "Separate"}
        </button>
      </section>

      <section className="card status">
        {status === STATES.IDLE && <div className="dim">Idle — ready.</div>}

        {status === STATES.PROCESSING && (
          <div>
            <div className="statusline">
              <span className="pill running">Processing</span>
              <span className="mono">{pct}%</span>
            </div>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
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
              <span className="pill ok">Done</span>
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

            <ul className="stems">
              {STEM_ORDER.map((name) => (
                <li key={name}>
                  <span className="stem-name">{name}</span>
                  <span className="mono ellipsis" title={result.stems[name]}>
                    {basename(result.stems[name])}
                  </span>
                </li>
              ))}
              <li className="original">
                <span className="stem-name">original</span>
                <span className="mono ellipsis" title={result.originalCopy}>
                  {basename(result.originalCopy)}
                </span>
              </li>
            </ul>
          </div>
        )}
      </section>

      <style jsx>{`
        .wrap {
          max-width: 560px;
          margin: 0 auto;
          padding: 48px 24px 64px;
        }
        .head {
          margin-bottom: 28px;
        }
        .title {
          font-size: 22px;
          font-weight: 700;
          letter-spacing: 0.18em;
        }
        .subtitle {
          margin-top: 4px;
          font-size: 12px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .banner {
          margin-bottom: 16px;
          padding: 10px 12px;
          border-radius: 8px;
          font-size: 13px;
        }
        .banner.danger {
          background: rgba(255, 107, 107, 0.1);
          border: 1px solid rgba(255, 107, 107, 0.3);
          color: var(--danger);
        }
        .card {
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: var(--radius);
          padding: 20px;
          margin-bottom: 16px;
        }
        .row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 0;
          border-bottom: 1px solid var(--line);
        }
        .row:first-child {
          padding-top: 0;
        }
        .label {
          flex: 0 0 64px;
          font-size: 11px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .value {
          flex: 1 1 auto;
          min-width: 0;
        }
        .ellipsis {
          display: block;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          direction: rtl;
          text-align: left;
        }
        .dim {
          color: var(--muted);
        }
        .small {
          font-size: 12px;
        }
        .hint {
          margin: 14px 0 18px;
          font-size: 12px;
          color: var(--muted);
          line-height: 1.6;
        }
        .hint code,
        .path-block code {
          background: var(--panel-2);
          padding: 1px 5px;
          border-radius: 4px;
        }
        .go {
          width: 100%;
          padding: 11px;
        }
        .status {
          min-height: 72px;
        }
        .statusline {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
        }
        .pill {
          display: inline-block;
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 3px 9px;
          border-radius: 999px;
          border: 1px solid var(--line);
        }
        .pill.running {
          color: var(--text);
        }
        .pill.ok {
          color: var(--ok);
          border-color: rgba(126, 224, 129, 0.4);
        }
        .pill.danger {
          color: var(--danger);
          border-color: rgba(255, 107, 107, 0.4);
        }
        .bar {
          height: 6px;
          background: var(--panel-2);
          border-radius: 999px;
          overflow: hidden;
        }
        .bar-fill {
          height: 100%;
          background: var(--accent);
          transition: width 200ms ease;
        }
        .err {
          margin: 10px 0 4px;
          color: var(--danger);
          font-size: 14px;
        }
        .path-block {
          margin: 4px 0 14px;
          padding: 8px 10px;
          background: var(--panel-2);
          border-radius: 6px;
          word-break: break-all;
          color: var(--muted);
        }
        .stems {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .stems li {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 7px 0;
          border-top: 1px solid var(--line);
        }
        .stems li.original {
          border-top: 1px solid var(--line);
          margin-top: 4px;
        }
        .stem-name {
          flex: 0 0 64px;
          font-size: 11px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .stems .mono {
          flex: 1 1 auto;
          min-width: 0;
        }
      `}</style>
    </main>
  );
}
