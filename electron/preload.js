"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  /** Open the native file picker. Resolves to an absolute path or null. */
  pickFile: () => ipcRenderer.invoke("dialog:pickFile"),

  /** The remembered separation model ("htdemucs" | "htdemucs_ft"). */
  getModel: () => ipcRenderer.invoke("config:model"),

  /**
   * This Mac, for recommending settings. Resolves to
   * { chip, appleSilicon, memoryGB, gpuSupported, savedProcessor: "gpu" | "cpu" | null }.
   */
  getSystemProfile: () => ipcRenderer.invoke("system:profile"),

  /**
   * Separate a song into the private cache, or return it if it's already there.
   * @param {string} inputPath  absolute path to the audio file
   * @param {string} model      "htdemucs" | "htdemucs_ft"
   * @param {string} processor  "gpu" | "cpu"; a failed GPU run retries on CPU
   * Resolves to { ok: true, entry: { id, title, model, stems } }
   *          or { ok: false, message }.
   */
  separate: (inputPath, model, processor) =>
    ipcRenderer.invoke("separation:start", { inputPath, model, processor }),

  /** This song's cached entry for a model, or null. */
  findCached: (inputPath, model) => ipcRenderer.invoke("cache:find", inputPath, model),

  /** Every cached song, most recently used first. */
  listRecent: () => ipcRenderer.invoke("cache:recent"),

  /** A cached song by id, or null if it has been removed. */
  openRecent: (id) => ipcRenderer.invoke("cache:open", id),

  /**
   * Pick a folder and copy a song's stems into a new folder inside it.
   * Resolves to { ok: true, dir } or { ok: false, canceled } / { ok: false, message }.
   */
  exportStems: (stems, title) => ipcRenderer.invoke("stems:export", stems, title),

  /** Open the feedback form, as Help › Report a Bug… / Request a Feature… do. */
  openFeedback: (type) => ipcRenderer.invoke("feedback:open", type),

  /** Reveal a file or folder in Finder. */
  showItem: (targetPath) => ipcRenderer.invoke("shell:showItem", targetPath),

  /**
   * Pick a folder and resolve it to the 4 stems.
   * Resolves to { ok: true, stems: {vocals,drums,bass,instrumental}, dir }
   *          or { ok: false, canceled } / { ok: false, message }.
   */
  pickStemsFolder: () => ipcRenderer.invoke("dialog:pickStemsFolder"),

  /** Read one stem .wav as an ArrayBuffer (for decodeAudioData). */
  readStemFile: (filePath) => ipcRenderer.invoke("stems:read", filePath),

  /** The system double-click interval in ms, clamped to 250-500. */
  getDoubleClickInterval: () => ipcRenderer.invoke("system:doubleClickMs"),

  /** Read the 3D device model (.glb) as an ArrayBuffer. */
  readDeviceModel: () => ipcRenderer.invoke("device:readModel"),

  /**
   * Fire a trackpad haptic tap. Fire-and-forget — never awaited, never throws.
   * @param {"generic"|"level"|"alignment"} pattern
   */
  haptic: (pattern) => ipcRenderer.send("haptics:tap", pattern),

  /**
   * Whether taps can be felt: "on", "off" (Force Click and haptic feedback is
   * off in System Settings), "none" (no Force Touch trackpad) or "unknown".
   */
  getHapticsStatus: () => ipcRenderer.invoke("haptics:status"),

  /** Open System Settings › Trackpad. */
  openTrackpadSettings: () => ipcRenderer.invoke("haptics:openSettings"),

  /**
   * Called when a GPU separation failed and is starting over on the CPU.
   * Returns an unsubscribe function.
   */
  onFallback: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("separation:fallback", listener);
    return () => ipcRenderer.removeListener("separation:fallback", listener);
  },

  /**
   * Called with "engine" when a separation first has to download the stem
   * engine, or "model" when it first has to download the chosen model's weights
   * (progress then follows the download), "starting" while the engine starts
   * up, and "separating" once the model is loaded and progress restarts at 0
   * for the song. Returns an unsubscribe function.
   */
  onStage: (handler) => {
    const listener = (_event, stage) => handler(stage);
    ipcRenderer.on("separation:stage", listener);
    return () => ipcRenderer.removeListener("separation:stage", listener);
  },

  /**
   * Subscribe to progress updates (0.0 - 1.0).
   * Returns an unsubscribe function.
   */
  onProgress: (handler) => {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("separation:progress", listener);
    return () => ipcRenderer.removeListener("separation:progress", listener);
  },
});
