"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  /** Open the native file picker. Resolves to an absolute path or null. */
  pickFile: () => ipcRenderer.invoke("dialog:pickFile"),

  /** The remembered separation model ("htdemucs" | "htdemucs_ft"). */
  getModel: () => ipcRenderer.invoke("config:model"),

  /**
   * Separate a song into the private cache, or return it if it's already there.
   * @param {string} inputPath  absolute path to the audio file
   * @param {string} model      "htdemucs" | "htdemucs_ft"
   * Resolves to { ok: true, entry: { id, title, model, stems } }
   *          or { ok: false, message }.
   */
  separate: (inputPath, model) =>
    ipcRenderer.invoke("separation:start", { inputPath, model }),

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

  /** Read the 3D device model (.glb) as an ArrayBuffer. */
  readDeviceModel: () => ipcRenderer.invoke("device:readModel"),

  /**
   * Fire a trackpad haptic tap. Fire-and-forget — never awaited, never throws.
   * @param {"generic"|"level"|"alignment"} pattern
   */
  haptic: (pattern) => ipcRenderer.send("haptics:tap", pattern),

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
