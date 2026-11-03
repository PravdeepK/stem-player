"use strict";

// The feedback window's only way out. `fields` is
// { title, description, steps, includeSystem, website }; the main process adds
// the report type and the system info itself.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("feedback", {
  /** { type: "bug" | "feature", title, limits, systemLines } */
  context: () => ipcRenderer.invoke("feedback:context"),

  /** The report exactly as it would be posted, title first. */
  preview: (fields) => ipcRenderer.invoke("feedback:preview", fields),

  /** Resolves to { ok: true, number, url } or { ok: false, code, message }. */
  submit: (fields) => ipcRenderer.invoke("feedback:submit", fields),

  /** Put the report on the clipboard. */
  copy: (fields) => ipcRenderer.invoke("feedback:copy", fields),

  /** Open GitHub's new-issue form, prefilled. Resolves to { truncated }. */
  openOnGitHub: (fields) => ipcRenderer.invoke("feedback:openOnGitHub", fields),

  /** Open the issue that was just created in the default browser. */
  openIssue: () => ipcRenderer.invoke("feedback:openIssue"),

  close: () => ipcRenderer.invoke("feedback:close"),
});
