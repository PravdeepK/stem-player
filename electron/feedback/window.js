"use strict";

// The Report a Bug / Request a Feature window: a small sheet with its own
// page, preload and session, which can't navigate or open anything itself.
// Everything that leaves the Mac goes through the main process here.
const { BrowserWindow, clipboard, ipcMain, net, session, shell } = require("electron");
const { spawnSync } = require("child_process");
const os = require("os");
const path = require("path");
const { LIMITS, systemLines } = require("./issue");
const { buildReport, buildPrefillUrl, collectSystemInfo, feedbackUrl, isIssueUrl, reportText, submitReport } = require("./report");

// From package.json rather than app.getVersion(), which is Electron's own
// version when the app is started from a script instead of `electron .`.
const { version: APP_VERSION } = require("../../package.json");
const PARTITION = "feedback"; // in memory only, nothing kept between runs
const TITLES = { bug: "Report a Bug", feature: "Request a Feature" };

function chip() {
  const out = spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : "";
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

/**
 * `engineInfo` resolves to { engine, python, override }: the stem engine's
 * Python (or null), the Python that makes stems, and STEM_PLAYER_PYTHON.
 * Returns { open(type, parent) }.
 */
function createFeedback({ engineInfo = async () => ({}) } = {}) {
  let win = null;
  let type = "bug";
  let system = null;
  let issueUrl = null;
  let registered = false;

  function register() {
    if (registered) return;
    registered = true;
    session.fromPartition(PARTITION).setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    const handle = (channel, fn) =>
      ipcMain.handle(channel, (event, ...args) => {
        if (!win || win.isDestroyed() || event.sender !== win.webContents) throw new Error("not the feedback window");
        return fn(...args);
      });
    const report = (fields) => buildReport(type, fields || {}, system);

    handle("feedback:context", async () => {
      if (!system) {
        const info = (await withTimeout(engineInfo().catch(() => null), 4000)) || {};
        system = collectSystemInfo({
          appVersion: APP_VERSION,
          macos: process.getSystemVersion(),
          chip: chip(),
          memoryBytes: os.totalmem(),
          ...info,
        });
      }
      return { type, title: TITLES[type], limits: LIMITS, systemLines: systemLines(system) };
    });
    handle("feedback:preview", async (fields) => reportText(report(fields)));
    handle("feedback:submit", async (fields) => {
      const result = await submitReport(report(fields), {
        url: feedbackUrl(),
        fetch: net.fetch,
        appVersion: APP_VERSION,
      });
      if (result.ok) issueUrl = result.url;
      return result;
    });
    handle("feedback:copy", async (fields) => {
      clipboard.writeText(reportText(report(fields)));
    });
    handle("feedback:openOnGitHub", async (fields) => {
      const { url, truncated } = buildPrefillUrl(report(fields));
      if (truncated) clipboard.writeText(reportText(report(fields)));
      await shell.openExternal(url);
      return { truncated };
    });
    handle("feedback:openIssue", async () => {
      if (isIssueUrl(issueUrl)) await shell.openExternal(issueUrl);
    });
    handle("feedback:close", async () => win.close());
  }

  function open(nextType, parent) {
    register();
    if (win && !win.isDestroyed()) {
      win.focus();
      return win;
    }
    type = nextType === "feature" ? "feature" : "bug";
    system = null;
    issueUrl = null;

    const hasParent = !!(parent && !parent.isDestroyed());
    win = new BrowserWindow({
      parent: hasParent ? parent : undefined,
      modal: hasParent,
      title: TITLES[type],
      width: 540,
      height: 680,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      backgroundColor: "#0d0d0d",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: true,
      },
    });

    // This page goes nowhere: links and redirects all stop here.
    const contents = win.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());

    win.once("ready-to-show", () => win.show());
    win.on("closed", () => {
      win = null;
    });
    win.loadFile(path.join(__dirname, "form.html"));
    return win;
  }

  return { open, window: () => win };
}

module.exports = { createFeedback };
