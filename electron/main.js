"use strict";

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { createStemCache } = require("./stemCache");
const { createStemEngine, formatSize, supportsMacOS, DOWNLOAD_BYTES, INSTALLED_BYTES } = require("./stemEngine");

// Load .env from the project root (optional). Values there populate
// process.env, which the Python subprocess inherits (e.g. HF_TOKEN).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const isDev = !!process.env.ELECTRON_START_URL;
const SEPARATE_SCRIPT = path.join(__dirname, "..", "python", "separate.py");
const SUPPORTED_EXTS = new Set([".mp3", ".wav", ".flac", ".m4a", ".mp4"]);
// About a dozen songs at roughly 170 MB of WAV each.
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

// --- locate a Python interpreter that actually has demucs ----------------
// A conda base env on PATH means a bare `python3` often resolves to one
// without demucs, so probe a list of candidates and cache the first that
// can `import demucs`. STEM_PLAYER_PYTHON always wins if set, then the stem
// engine (electron/stemEngine.js) once it has been downloaded.
let resolvedPython = null;
let stemEngine = null;

function pythonCandidates() {
  const list = [];
  if (process.env.STEM_PLAYER_PYTHON) list.push(process.env.STEM_PLAYER_PYTHON);
  const engine = stemEngine && stemEngine.python();
  if (engine) list.push(engine);
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

// The engine's Python runs with only its own packages and keeps model weights inside it.
function pythonEnv(cmd) {
  return stemEngine && cmd === stemEngine.python() ? stemEngine.env(process.env) : process.env;
}

/** Look again next time, after the engine is installed or removed. */
function forgetPython() {
  resolvedPython = null;
  pythonProbe = null;
}

function resolvePython() {
  if (resolvedPython) return resolvedPython;
  for (const cand of pythonCandidates()) {
    try {
      const probe = spawnSync(cand, ["-c", "import demucs"], {
        timeout: 15000,
        env: pythonEnv(cand),
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

// Async twin of resolvePython for startup: it also asks whether this Mac's GPU
// can run Demucs, and never blocks the window while torch imports.
let pythonProbe = null;

function exitCode(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { timeout: 30000, env: pythonEnv(cmd) });
    } catch {
      resolve(null);
      return;
    }
    child.on("error", () => resolve(null));
    child.on("close", resolve);
  });
}

function probePython() {
  if (!pythonProbe) {
    pythonProbe = (async () => {
      const check =
        "import sys, demucs, torch; sys.exit(0 if torch.backends.mps.is_available() else 3)";
      for (const cand of pythonCandidates()) {
        const code = await exitCode(cand, ["-c", check]);
        if (code === 0 || code === 3) return { python: cand, gpu: code === 0 };
      }
      return { python: null, gpu: false };
    })();
  }
  return pythonProbe;
}

let mainWindow = null;
/** Track the in-flight separation so we never run two at once. */
let activeJob = null;
let quitting = false;
let stemCache = null;

// --- tiny persisted config ------------------------------------------------
// Stores { lastExportDir, lastModel, lastProcessor } in userData/config.json so the pickers can
// default to wherever the user last put stems. lastOutputDir is from before the
// cache, and still points at any stems made back then.
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

function defaultStemsFolder() {
  const config = readConfig();
  for (const saved of [config.lastExportDir, config.lastOutputDir]) {
    if (saved && fs.existsSync(saved)) return saved;
  }
  try {
    return app.getPath("music");
  } catch {
    return app.getPath("home");
  }
}

const EXTERNAL_HOSTS = new Set(["github.com", "linkedin.com", "www.linkedin.com"]);

function openExternal(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === "https:" && EXTERNAL_HOSTS.has(hostname)) shell.openExternal(url);
  } catch {
    /* not a URL worth opening */
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 620,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Links open in the default browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("https:")) {
      event.preventDefault();
      openExternal(url);
    }
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

// --- the stem engine ------------------------------------------------------
// Downloaded the first time a Mac without its own Python makes stems, and
// removable from the app menu to get the space back.
function buildMenu() {
  const appMenu = {
    label: app.name,
    submenu: [
      { role: "about" },
      { type: "separator" },
      { id: "remove-engine", label: "Remove Stem Engine…", click: () => removeEngine() },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
  const template = [appMenu, { role: "fileMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  refreshMenu();
}

function refreshMenu() {
  const menu = Menu.getApplicationMenu();
  const item = menu && menu.getMenuItemById("remove-engine");
  if (item) item.enabled = !activeJob && !!stemEngine.python();
}

async function removeEngine() {
  if (activeJob || !stemEngine.python()) return;
  const size = await stemEngine.size();
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    message: "Remove the stem engine?",
    detail:
      `This frees ${formatSize(size)}. Songs you've already separated stay. ` +
      "Making stems again will download the engine again.",
    buttons: ["Remove", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0 || activeJob) return;
  const removal = stemEngine.remove();
  forgetPython();
  refreshMenu();
  try {
    await removal;
  } catch (err) {
    console.error("[engine] removal failed:", err);
    dialog.showErrorBox("Couldn't remove the stem engine", String(err.message));
  }
  refreshMenu();
}

/**
 * Ask to download the engine and install it, reporting through the separation
 * progress bar. Resolves to { ok: true, python } or { ok: false, message }.
 */
async function offerEngine() {
  if (!supportsMacOS(process.getSystemVersion())) {
    return { ok: false, message: "Making stems needs macOS 14 or later." };
  }
  // Holds the job slot from the question on, so nothing else starts meanwhile.
  const abort = new AbortController();
  activeJob = { kill: () => abort.abort() };
  refreshMenu();
  const send = (channel, value) => mainWindow && mainWindow.webContents.send(channel, value);
  try {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      message: "Download the stem engine?",
      detail:
        `Making stems needs a one-time download of about ${formatSize(DOWNLOAD_BYTES)} ` +
        `(Python, PyTorch and Demucs), which takes about ${formatSize(INSTALLED_BYTES)} on disk. ` +
        "Each quality setting also downloads its model the first time it's used. " +
        "You can remove the engine from the Stem Player menu.",
      buttons: ["Download", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return { ok: false, message: "Making stems needs the stem engine." };
    if (abort.signal.aborted) return { ok: false, message: "Cancelled." };

    send("separation:stage", "engine");
    const python = await stemEngine.install({
      signal: abort.signal,
      onProgress: (value) => send("separation:progress", value),
    });
    console.log("[engine] installed:", python);
    forgetPython();
    send("separation:stage", "separating");
    send("separation:progress", 0);
    return { ok: true, python };
  } catch (err) {
    console.error("[engine] install failed:", err);
    if (err.code === "ENGINE_NO_SPACE") {
      return { ok: false, message: `The stem engine ${err.message} on your Mac.` };
    }
    return {
      ok: false,
      message: "Couldn't download the stem engine. Check your internet connection and try again.",
    };
  } finally {
    activeJob = null;
    refreshMenu();
  }
}

app.whenReady().then(() => {
  // Packaged builds take the dock icon from build/icon.icns.
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, "..", "assets", "icon", "build", "icon-macos-1024.png"));
  }
  stemCache = createStemCache(path.join(app.getPath("userData"), "stem-cache"), MAX_CACHE_BYTES);
  stemCache.clearTemp();
  stemEngine = createStemEngine(path.join(app.getPath("userData"), "stem-engine"));
  stemEngine.clearLeftovers().catch((err) => console.error("[engine] cleanup failed:", err));
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  quitting = true;
  if (activeJob) activeJob.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// --- IPC: pick an audio file --------------------------------------------
ipcMain.handle("dialog:pickFile", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a song",
    properties: ["openFile"],
    filters: [{ name: "Audio", extensions: ["mp3", "wav", "flac", "m4a", "mp4"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// --- separation model ------------------------------------------------
const ALLOWED_MODELS = new Set(["htdemucs", "htdemucs_ft"]);
const DEFAULT_MODEL = "htdemucs";

ipcMain.handle("config:model", async () => {
  const saved = readConfig().lastModel;
  return ALLOWED_MODELS.has(saved) ? saved : DEFAULT_MODEL;
});

// The user's double-click speed (System Settings › Mouse or Trackpad), so a
// double-click on a groove means the same thing it does everywhere else on the
// Mac. Clamped so a click never waits long to become a mute.
ipcMain.handle("system:doubleClickMs", async () => {
  const { systemPreferences } = require("electron");
  const seconds = systemPreferences.getUserDefault("com.apple.mouse.doubleClickThreshold", "float");
  const ms = seconds > 0 ? Math.round(seconds * 1000) : 350;
  return Math.min(500, Math.max(250, ms));
});

// What the renderer needs to recommend settings for this Mac, plus the user's
// own last choice, which wins over any recommendation.
function sysctl(key) {
  const out = spawnSync("sysctl", ["-n", key], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : "";
}

ipcMain.handle("system:profile", async () => {
  const chip = sysctl("machdep.cpu.brand_string");
  const { python, gpu } = await probePython();
  const saved = readConfig().lastProcessor;
  return {
    chip,
    // An Intel build under Rosetta still reports an Apple chip here.
    appleSilicon: process.arch === "arm64" || sysctl("sysctl.proc_translated") === "1",
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    // With no Python yet, the stem engine it would download runs on the GPU.
    gpuSupported: python ? gpu : supportsMacOS(process.getSystemVersion()),
    savedProcessor: saved === "gpu" || saved === "cpu" ? saved : null,
  };
});

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

// --- IPC: the private stem cache -----------------------------------------
ipcMain.handle("cache:find", async (_event, inputPath, model) => {
  if (typeof inputPath !== "string" || !ALLOWED_MODELS.has(model)) return null;
  try {
    return stemCache.touch(await stemCache.idFor(inputPath, model));
  } catch (err) {
    console.error("[cache] lookup failed:", err);
    return null;
  }
});

ipcMain.handle("cache:recent", async () => stemCache.list());

ipcMain.handle("cache:open", async (_event, id) => stemCache.touch(String(id)));

// Copy a song's stems somewhere permanent. Always a new folder, so an export can
// never replace anything already there.
ipcMain.handle("stems:export", async (_event, stems, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose where to export the stems",
    defaultPath: defaultStemsFolder(),
    buttonLabel: "Export Here",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  const base = result.filePaths[0];
  writeConfig({ lastExportDir: base });

  const name = path.basename(String(title)) || "stems";
  let dir = path.join(base, name);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(base, `${name} (${n})`);

  try {
    fs.mkdirSync(dir);
    for (const stem of STEM_NAMES) {
      await fs.promises.copyFile(stems[stem], path.join(dir, `${stem}.wav`));
    }
    return { ok: true, dir };
  } catch (err) {
    console.error("[export] failed:", err);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, message: "Couldn't export the stems." };
  }
});

// Pick a folder + resolve it in one call (used by "Open stems folder").
ipcMain.handle("dialog:pickStemsFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select a folder containing the 4 stems",
    defaultPath: defaultStemsFolder(),
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

// --- IPC: the 3D device model -------------------------------------------
// Read here rather than fetched by the renderer: fetch() can't load file:// in
// the static build, and this keeps one load path for dev and packaged runs.
const DEVICE_MODEL_PATH = path.join(__dirname, "..", "assets", "models", "stem-player.glb");

ipcMain.handle("device:readModel", async () => {
  const buf = await fs.promises.readFile(DEVICE_MODEL_PATH);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// --- IPC: trackpad haptics --------------------------------------------
// The native addon is optional: if it was never built (or fails to load) the
// app runs exactly as before, minus the taps. Never let this break startup.
let haptics = null;
try {
  haptics = require("../native/haptics/build/Release/haptics.node");
} catch (err) {
  console.log("[haptics] native module unavailable, taps disabled:", err.message);
}

const HAPTIC_PATTERNS = new Set(["generic", "level", "alignment"]);

// Fire-and-forget (`send`, not `invoke`) so a tap never adds latency to the
// click that triggered it.
ipcMain.on("haptics:tap", (_event, pattern) => {
  if (!haptics) return;
  try {
    haptics.perform(HAPTIC_PATTERNS.has(pattern) ? pattern : "generic");
  } catch {
    /* a failed tap is never worth surfacing */
  }
});

// --- IPC: run separation ---------------------------------------------
ipcMain.handle("separation:start", async (_event, args) => {
  const inputPath = args && args.inputPath;
  const model = ALLOWED_MODELS.has(args && args.model) ? args.model : DEFAULT_MODEL;
  const processor = args && args.processor === "cpu" ? "cpu" : "gpu";

  if (activeJob) {
    return { ok: false, message: "A separation is already running." };
  }

  if (typeof inputPath !== "string" || !fs.existsSync(inputPath)) {
    return { ok: false, message: "File not found." };
  }

  // Making stems is Apple silicon only until the web version.
  if (process.arch !== "arm64" && sysctl("sysctl.proc_translated") !== "1") {
    return { ok: false, message: "Making stems needs a Mac with Apple silicon." };
  }

  const ext = path.extname(inputPath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    return {
      ok: false,
      message: "Unsupported format. Use mp3, wav, flac, m4a, or mp4.",
    };
  }

  let id;
  try {
    id = await stemCache.idFor(inputPath, model);
  } catch (err) {
    console.error("[separation] could not read the file:", err);
    return { ok: false, message: "Could not read that file." };
  }
  const cached = stemCache.touch(id);
  if (cached) return { ok: true, entry: cached };

  let python = resolvePython();
  if (!python) {
    console.log("[separation] no Python with demucs found, offering the stem engine. Tried:", pythonCandidates().join(", "));
    const engine = await offerEngine();
    if (!engine.ok) return engine;
    python = engine.python;
  }

  const title = path.basename(inputPath, ext);

  let stemsDir;
  try {
    stemsDir = stemCache.begin(id);
  } catch (err) {
    console.error("[separation] failed to prepare the cache:", err);
    return { ok: false, message: "Could not prepare a place for the stems." };
  }

  writeConfig({ lastModel: model, lastProcessor: processor });

  const useGpu = processor === "gpu" && (await probePython()).gpu;
  let run = await runDemucs(python, inputPath, stemsDir, model, useGpu ? "mps" : "cpu");
  if (!run.ok && useGpu && !quitting) {
    console.error("[separation] GPU run failed, retrying on the CPU:", run.detail);
    if (mainWindow) mainWindow.webContents.send("separation:fallback");
    stemsDir = stemCache.begin(id);
    run = await runDemucs(python, inputPath, stemsDir, model, "cpu");
  }

  if (run.ok) {
    const entry = stemCache.commit(id, title, model);
    stemCache.prune(id);
    return { ok: true, entry };
  }
  stemCache.abandon(id);
  console.error("[separation] failed:", run.detail);
  return { ok: false, message: "Separation failed. See the console for details." };
});

/** One Demucs run. Resolves to { ok } or { ok: false, detail }. */
function runDemucs(python, inputPath, stemsDir, model, device) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [SEPARATE_SCRIPT, inputPath, stemsDir, model, device], {
        cwd: path.join(__dirname, ".."),
        env: pythonEnv(python),
      });
    } catch (err) {
      resolve({ ok: false, detail: `could not start python: ${err.message}` });
      return;
    }

    activeJob = child;
    refreshMenu();
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
      refreshMenu();
      if (stderrBuf.trim()) {
        console.error("[separation] python stderr:\n" + stderrBuf.trim());
      }

      if (resultMessage && resultMessage.type === "done") {
        resolve({ ok: true });
        return;
      }
      resolve({
        ok: false,
        detail:
          (resultMessage && resultMessage.message) ||
          `Separation process exited with code ${code}.`,
      });
    });
  });
}
