"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  /** Open the native file picker. Resolves to an absolute path or null. */
  pickFile: () => ipcRenderer.invoke("dialog:pickFile"),

  /** Open the native folder picker. Resolves to an absolute path or null. */
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),

  /** The remembered output base folder (falls back to ~/Music, then ~). */
  getOutputBase: () => ipcRenderer.invoke("config:outputBase"),

  /** The remembered separation model ("htdemucs" | "htdemucs_ft"). */
  getModel: () => ipcRenderer.invoke("config:model"),

  /**
   * Start separation.
   * @param {string} inputPath  absolute path to the audio file
   * @param {string} outputBase absolute path to the folder stems go under
   * @param {string} model      "htdemucs" | "htdemucs_ft"
   * Resolves to { ok: true, stems, songDir, stemsDir, originalCopy }
   *          or { ok: false, message }.
   */
  separate: (inputPath, outputBase, model) =>
    ipcRenderer.invoke("separation:start", { inputPath, outputBase, model }),

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
