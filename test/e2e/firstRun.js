// End-to-end test of a friend's first song: no Python with Demucs anywhere, so
// the app has to offer the stem engine, download it, fetch the model weights
// and only then separate. It watches the progress text the whole way and fails
// if a bar ever starts over under the same label, which is what a tester saw
// when the engine download read "Separating… 100%" and then went back to 0%.
//
// Run with `npm run test:e2e:first-run`. It downloads the real engine (about
// 180 MB) and both models (about 400 MB) into throwaway app data, so it takes
// a few minutes and needs the internet. Nothing it installs is kept.
const { app, dialog, BrowserWindow } = require("electron");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "stem-player-first-run-"));
app.setPath("userData", path.join(WORK, "userData"));

// Hide every Python the app could find on its own. Demucs installed with
// `pip install --user` lives in the user site, which this turns off.
process.env.PYTHONNOUSERSITE = "1";
delete process.env.STEM_PLAYER_PYTHON;

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args]);
  if (r.status !== 0) {
    console.error("ffmpeg failed or missing:", r.stderr && r.stderr.toString());
    process.exit(1);
  }
}

// Two different short songs, so the second can't come from the cache.
const songs = [220, 247].map((hz, i) => {
  const file = path.join(WORK, `song ${i + 1}.wav`);
  ffmpeg([
    "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=8`,
    "-f", "lavfi", "-i", "anoisesrc=d=8:c=pink:a=0.05",
    "-filter_complex", "amix=inputs=2", "-ac", "2", "-ar", "44100", file,
  ]);
  return file;
});

let nextFile = songs[0];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nextFile] });
// Answers for the "Download the stem engine?" question, in order.
const engineAnswers = [];
const engineAsked = [];
dialog.showMessageBox = async (_w, o) => {
  engineAsked.push(o.message);
  return { response: engineAnswers.shift() ?? 1 };
};

require(path.join(__dirname, "..", "..", "electron", "main.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
};

async function run(win) {
  const wc = win.webContents;
  win.showInactive();
  wc.setBackgroundThrottling(false);
  const logs = [];
  wc.on("console-message", (_e, level, msg) => logs.push(`[${level}] ${msg}`));
  const js = (code) => wc.executeJavaScript(code);
  const byText = (t) => `[...document.querySelectorAll('.drawer button')].find(b=>b.textContent.includes(${JSON.stringify(t)}))`;
  const press = async (t) => {
    await js(`${byText(t)}.click()`);
    await sleep(300);
  };
  const busy = () => js(`!!document.querySelector('.drawer .progress')`);
  const sample = () =>
    js(`(()=>{const q=(s)=>document.querySelector(s)?.textContent??'';return {
      readout:q('.readout-title'), line:q('.progress-line span'), pct:q('.progress-line .dim'),
      note:q('.drawer .progress .footnote')}})()`);
  await sleep(2500);

  /**
   * Press Separate and record what the progress area says until it's done.
   * Returns the distinct phases, each { label, first, last, notes }, in order.
   */
  async function separate() {
    await press("Separate");
    const phases = [];
    let restarted = null;
    for (let i = 0; i < 6000 && (await busy()); i++) {
      const s = await sample();
      const pct = parseInt(s.pct, 10);
      const phase = phases[phases.length - 1];
      if (!phase || phase.label !== s.line) {
        phases.push({ label: s.line, first: pct, last: pct, readout: s.readout, notes: new Set([s.note.replace(/\d+:\d+|\d+s/g, "#")]) });
      } else {
        if (pct < phase.last && !restarted) restarted = `${s.line} went from ${phase.last}% to ${pct}%`;
        phase.last = Math.max(phase.last, pct);
        phase.notes.add(s.note.replace(/\d+:\d+|\d+s/g, "#"));
      }
      await sleep(200);
    }
    const timeline = phases.map((p) => `${p.label} ${p.first}→${p.last}%`).join(" | ");
    console.log("  timeline:", timeline);
    for (const p of phases) console.log(`  ${p.label} — readout "${p.readout}" — notes: ${[...p.notes].join(" / ")}`);
    check("progress never starts over under the same label", !restarted, restarted || "");
    return phases;
  }

  // 1. Saying no to the download leaves the app as it was, with a reason.
  await press("Choose…");
  engineAnswers.push(1);
  await press("Separate");
  for (let i = 0; i < 50 && (await busy()); i++) await sleep(200);
  const err = await js(`document.querySelector('.drawer .err')?.textContent ?? ''`);
  check("declining the engine says why nothing happened", err === "Making stems needs the stem engine.", err);
  check("and the engine is asked about once", engineAsked.length === 1, JSON.stringify(engineAsked));
  check("and nothing was installed", !fs.existsSync(path.join(app.getPath("userData"), "stem-engine")));

  // 2. The first real song: engine, then the Fast model, then separating.
  engineAnswers.push(0);
  const first = await separate();
  check("the engine was asked about again", engineAsked.length === 2);
  const labels = first.map((p) => p.label);
  check("the engine download has its own label", /stem engine/i.test(labels[0] || ""), labels[0]);
  // It sits at 100% only for a moment, between the samples.
  check("and nearly finishes before anything else starts", first[0] && first[0].last >= 90, `${first[0] && first[0].last}%`);
  check("then it gets ready, downloads the Fast model and separates", labels.slice(1).join(", ") === "Getting ready…, Downloading the Fast model…, Separating…", labels.join(", "));
  check("separating comes last", /^Separating/.test(labels[labels.length - 1] || ""), labels.join(", "));
  check("no label repeats after another one", new Set(labels).size === labels.length, labels.join(", "));
  check("the main screen says the same thing as the menu", first.every((p) => p.readout.startsWith(p.label.replace(/…$/, ""))), first.map((p) => p.readout).join(" | "));
  await sleep(2500);
  check("the song loads itself", (await js(`document.querySelector('.readout-title').textContent`)) === "song 1" && (await js(`document.querySelectorAll('.stem').length`)) === 4);
  const engineRoot = path.join(app.getPath("userData"), "stem-engine");
  check("the model weights stay inside the engine", fs.existsSync(path.join(engineRoot, "models", "huggingface", "hub", "models--adefossez--HTDemucs")));

  // 3. Another song, offline: the Fast model is already here, so it still works.
  // A proxy that refuses every connection stands in for no internet; the
  // engine's Python reads it when each run starts.
  const offline = (on) => {
    for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      if (on) process.env[key] = "http://127.0.0.1:9";
      else delete process.env[key];
    }
  };
  offline(true);
  nextFile = songs[1];
  await press("Choose…");
  const second = await separate();
  check("a second song asks for no download", engineAsked.length === 2 && second.map((p) => p.label).join(", ") === "Getting ready…, Separating…", second.map((p) => p.label).join(", "));
  await sleep(2500);
  check("and separates offline from the model already downloaded", (await js(`document.querySelector('.readout-title').textContent`)) === "song 2");

  // 4. Best for the first time, still offline: a clear reason, and no CPU retry.
  await press("Best");
  let sawFallback = false;
  await press("Separate");
  for (let i = 0; i < 600 && (await busy()); i++) {
    if ((await js(`document.querySelector('.drawer').textContent`)).includes("CPU is finishing")) sawFallback = true;
    await sleep(200);
  }
  const offlineErr = await js(`document.querySelector('.drawer .err')?.textContent ?? ''`);
  check("a model that can't download says so", offlineErr === "Couldn't download the Best model. Check your internet connection and try again.", offlineErr);
  check("and isn't blamed on the GPU", !sawFallback);
  offline(false);

  // 5. Best for the first time, online: four weight files, one download label.
  await press("Best");
  const best = await separate();
  const bestLabels = best.map((p) => p.label).join(", ");
  check("Best's first use downloads its model under its own label", bestLabels === "Getting ready…, Downloading the Best model…, Separating…", bestLabels);
  const bestDownload = best.find((p) => /Best model/.test(p.label));
  check("and its download climbs past a quarter, so all four files count", bestDownload && bestDownload.last > 25, `${bestDownload && bestDownload.last}%`);

  console.log("--- console errors");
  console.log(logs.filter((l) => /^\[(2|3)\]/.test(l)).join("\n") || "none");
  const failedCount = results.filter((x) => !x.ok).length;
  console.log(`${results.length - failedCount}/${results.length} passed`);
  return failedCount;
}

app.whenReady().then(async () => {
  const wait = setInterval(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    clearInterval(wait);
    let failed = 1;
    try {
      failed = await run(win);
    } catch (e) {
      console.error("harness error", e);
    }
    fs.rmSync(WORK, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  }, 200);
  setTimeout(() => {
    console.error("timeout");
    fs.rmSync(WORK, { recursive: true, force: true });
    app.exit(1);
  }, 30 * 60 * 1000);
});
