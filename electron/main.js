"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");

// Load .env from the project root (optional). Values there populate
// process.env, which the Python subprocess inherits (e.g. HF_TOKEN).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const isDev = !!process.env.ELECTRON_START_URL;
const SEPARATE_SCRIPT = path.join(__dirname, "..", "python", "separate.py");
const SUPPORTED_EXTS = new Set([".mp3", ".wav", ".flac", ".m4a", ".mp4"]);

// --- locate a Python interpreter that actually has demucs ----------------
// A conda base env on PATH means a bare `python3` often resolves to one
// without demucs, so probe a list of candidates and cache the first that
// can `import demucs`. STEM_PLAYER_PYTHON always wins if set.
let resolvedPython = null;

function pythonCandidates() {
  const list = [];
  if (process.env.STEM_PLAYER_PYTHON) list.push(process.env.STEM_PLAYER_PYTHON);
  list.push(
    "python3",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3",
    "python"
  );
  return [...new Set(list)];
}

function resolvePython() {
  if (resolvedPython) return resolvedPython;
  for (const cand of pythonCandidates()) {
    try {
      const probe = spawnSync(cand, ["-c", "import demucs"], {
        timeout: 15000,
      });
      if (probe.status === 0) {
        if (cand !== "python3") {
          console.log(`[python] using interpreter with demucs: ${cand}`);
        }
        resolvedPython = cand;
        return cand;
      }
    } catch {
      // candidate not found / not executable — try the next one
    }
  }
  return null;
}

let mainWindow = null;
/** Track the in-flight separation so we never run two at once. */
let activeJob = null;

// --- tiny persisted config ------------------------------------------------
// Stores { lastOutputDir } in userData/config.json so the folder picker can
// default to wherever the user last saved stems.
function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) || {};
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  try {
    const next = { ...readConfig(), ...patch };
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.error("[config] failed to write:", err);
  }
}

function defaultOutputBase() {
  const saved = readConfig().lastOutputDir;
  if (saved && fs.existsSync(saved)) return saved;
  try {
    return app.getPath("music");
  } catch {
    return app.getPath("home");
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 620,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(process.env.ELECTRON_START_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "out", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// --- IPC: pick an audio file --------------------------------------------
ipcMain.handle("dialog:pickFile", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select an audio file",
    properties: ["openFile"],
    filters: [{ name: "Audio", extensions: ["mp3", "wav", "flac", "m4a", "mp4"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// --- IPC: pick the output folder --------------------------------------
ipcMain.handle("dialog:pickFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose where to save stems",
    defaultPath: defaultOutputBase(),
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const chosen = result.filePaths[0];
  writeConfig({ lastOutputDir: chosen });
  return chosen;
});

// --- IPC: current remembered output folder ---------------------------
ipcMain.handle("config:outputBase", async () => defaultOutputBase());

// --- IPC: reveal a file/folder in Finder ----------------------------
ipcMain.handle("shell:showItem", async (_event, targetPath) => {
  if (typeof targetPath === "string" && targetPath.length > 0) {
    shell.showItemInFolder(targetPath);
  }
});

// --- stem loading (Phase 2) ----------------------------------------------
const STEM_NAMES = ["vocals", "drums", "bass", "instrumental"];
// 200 MB ceiling per stem file — generous for WAV, guards against nonsense.
const MAX_STEM_BYTES = 200 * 1024 * 1024;

/**
 * Given a folder, resolve it to a canonical
 * { vocals, drums, bass, instrumental } map of absolute WAV paths, or null if
 * the 4 stems aren't all there. Accepts either a stems/ folder or its parent,
 * and maps a legacy other.wav -> instrumental.
 */
function resolveStemsFolder(dir) {
  const roots = [dir, path.join(dir, "stems")];
  for (const root of roots) {
    let entries;
    try {
      entries = new Set(fs.readdirSync(root).map((f) => f.toLowerCase()));
    } catch {
      continue;
    }
    const pick = (name) => {
      if (entries.has(`${name}.wav`)) return path.join(root, `${name}.wav`);
      return null;
    };
    const map = {
      vocals: pick("vocals"),
      drums: pick("drums"),
      bass: pick("bass"),
      instrumental: pick("instrumental") || pick("other"),
    };
    if (STEM_NAMES.every((n) => map[n])) return map;
  }
  return null;
}

// Pick a folder + resolve it in one call (used by the "Load stems folder" button).
ipcMain.handle("dialog:pickStemsFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select a folder containing the 4 stems",
    defaultPath: defaultOutputBase(),
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  const dir = result.filePaths[0];
  const stems = resolveStemsFolder(dir);
  if (!stems) {
    console.error("[stems] folder has no complete stem set:", dir);
    return {
      ok: false,
      message: "That folder doesn't contain vocals/drums/bass/instrumental .wav files.",
    };
  }
  return { ok: true, stems, dir };
});

// Read one stem file as raw bytes for decodeAudioData in the renderer.
ipcMain.handle("stems:read", async (_event, filePath) => {
  if (typeof filePath !== "string") throw new Error("bad path");
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".wav") throw new Error(`refusing to read non-wav: ${filePath}`);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_STEM_BYTES) throw new Error(`stem file too large: ${filePath}`);
  const buf = await fs.promises.readFile(filePath);
  // Return a tightly-sized ArrayBuffer (structured-clone friendly).
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// --- IPC: run separation ---------------------------------------------
ipcMain.handle("separation:start", async (_event, args) => {
  const inputPath = args && args.inputPath;
  const outputBase = args && args.outputBase;

  if (activeJob) {
    return { ok: false, message: "A separation is already running." };
  }

  if (typeof inputPath !== "string" || !fs.existsSync(inputPath)) {
    return { ok: false, message: "File not found." };
  }

  const ext = path.extname(inputPath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    return {
      ok: false,
      message: "Unsupported format. Use mp3, wav, flac, m4a, or mp4.",
    };
  }

  if (typeof outputBase !== "string" || outputBase.length === 0) {
    return { ok: false, message: "No output folder chosen." };
  }

  const python = resolvePython();
  if (!python) {
    console.error(
      "[separation] no Python interpreter with demucs found. Tried:",
      pythonCandidates().join(", "),
      "\nSet STEM_PLAYER_PYTHON to one that has it."
    );
    return {
      ok: false,
      message:
        "Couldn't find a Python with demucs installed. Set STEM_PLAYER_PYTHON.",
    };
  }

  const songName = path.basename(inputPath, ext);

  let songDir;
  let stemsDir;
  let originalCopy;
  try {
    fs.mkdirSync(outputBase, { recursive: true });
    songDir = path.join(outputBase, songName);
    // Overwrite any existing folder for this song to avoid duplicates.
    fs.rmSync(songDir, { recursive: true, force: true });
    stemsDir = path.join(songDir, "stems");
    fs.mkdirSync(stemsDir, { recursive: true });
    // Copy the source file alongside the stems/ folder.
    originalCopy = path.join(songDir, `${songName}${ext}`);
    fs.copyFileSync(inputPath, originalCopy);
  } catch (err) {
    console.error("[separation] failed to prepare output folder:", err);
    return { ok: false, message: "Could not create the output folder." };
  }

  // Remember this base for next time.
  writeConfig({ lastOutputDir: outputBase });

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [SEPARATE_SCRIPT, inputPath, stemsDir], {
        cwd: path.join(__dirname, ".."),
      });
    } catch (err) {
      console.error("[separation] failed to spawn python:", err);
      resolve({ ok: false, message: "Could not start the separation process." });
      return;
    }

    activeJob = child;
    let stdoutBuf = "";
    let stderrBuf = "";
    let resultMessage = null; // {type:'done'|'error', ...}

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          console.error("[separation] non-JSON stdout line:", line);
          continue;
        }
        if (msg.type === "progress" && mainWindow) {
          mainWindow.webContents.send("separation:progress", msg.value);
        } else if (msg.type === "done" || msg.type === "error") {
          resultMessage = msg;
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk;
    });

    child.on("error", (err) => {
      console.error("[separation] subprocess error:", err);
    });

    child.on("close", (code) => {
      activeJob = null;
      if (stderrBuf.trim()) {
        console.error("[separation] python stderr:\n" + stderrBuf.trim());
      }

      if (resultMessage && resultMessage.type === "done") {
        resolve({
          ok: true,
          stems: resultMessage.stems,
          songDir,
          stemsDir,
          originalCopy,
        });
        return;
      }

      const detail =
        (resultMessage && resultMessage.message) ||
        `Separation process exited with code ${code}.`;
      console.error("[separation] failed:", detail);
      resolve({
        ok: false,
        message: "Separation failed. See the console for details.",
      });
    });
  });
});
