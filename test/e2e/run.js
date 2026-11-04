// End-to-end test: drives the real app from its file:// build with real input
// events, then reads the DOM, the files it writes, and the haptics it sends.
// Run with `npm run test:e2e` (or `npm run test:e2e:gpu-fail` to prove the CPU
// fallback). Needs ffmpeg, and Python with Demucs for the separation checks.
//
// Nothing here ships. It stubs only the native dialogs and shell links, and runs
// against throwaway app data in a temp folder, never your real settings or cache.
const { app, dialog, BrowserWindow, ipcMain, shell } = require("electron");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "stem-player-e2e-"));
app.setPath("userData", path.join(WORK, "userData"));
const OUT = path.join(WORK, "shots");
fs.mkdirSync(OUT, { recursive: true });

const opened = [];
shell.openExternal = async (url) => opened.push(url);

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args]);
  if (r.status !== 0) {
    console.error("ffmpeg failed or missing:", r.stderr && r.stderr.toString());
    process.exit(1);
  }
}

// Four 45-second tones stand in for a separated song, named after the folder.
// The drums are a struck 110 Hz tone twice a second, alternating loud and
// soft, so they have beats to tap and some to drop at a lower volume.
const STEMS_TITLE = "Test Song";
const STEMS = path.join(WORK, STEMS_TITLE);
fs.mkdirSync(STEMS);
for (const [name, filter] of [
  ["vocals", "sine=frequency=440:duration=45"],
  ["drums", "aevalsrc=exprs=sin(2*PI*110*t)*exp(-12*mod(t\\,0.5))*(1-0.65*mod(floor(2*t)\\,2)):d=45:s=44100"],
  ["bass", "sine=frequency=55:duration=45"],
  ["instrumental", "sine=frequency=660:duration=45,tremolo=f=3:d=0.8"],
]) {
  ffmpeg(["-f", "lavfi", "-i", filter, "-ac", "2", "-ar", "44100", path.join(STEMS, `${name}.wav`)]);
}

// A short song to actually separate.
const SONG = path.join(WORK, "tiny song.wav");
ffmpeg([
  "-f", "lavfi", "-i", "sine=frequency=220:duration=8",
  "-f", "lavfi", "-i", "sine=frequency=330:duration=8",
  "-f", "lavfi", "-i", "anoisesrc=d=8:c=pink:a=0.05",
  "-filter_complex", "amix=inputs=3", "-ac", "2", "-ar", "44100", SONG,
]);
const RENAMED = path.join(WORK, "renamed copy.wav");
fs.copyFileSync(SONG, RENAMED);
const EXPORT_TO = path.join(WORK, "exports");
fs.mkdirSync(EXPORT_TO);

// With FAIL_GPU=1, every GPU separation fails, to prove the CPU fallback.
if (process.env.FAIL_GPU) {
  const candidates = [process.env.STEM_PLAYER_PYTHON, "python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];
  const real = candidates.filter(Boolean).find((c) => spawnSync(c, ["-c", "import demucs"]).status === 0);
  const wrapper = path.join(WORK, "fail-gpu-python.sh");
  fs.writeFileSync(
    wrapper,
    `#!/bin/bash\nif [ "$1" != "-c" ] && [ "\${5:-}" = "mps" ]; then echo "simulated GPU failure" >&2; exit 1; fi\nexec "${real}" "$@"\n`,
    { mode: 0o755 }
  );
  process.env.STEM_PLAYER_PYTHON = wrapper;
}

let dialogCalls = 0;
let nextFile = SONG;
dialog.showOpenDialog = async (_w, o) => {
  dialogCalls++;
  const pick = o.properties.includes("openFile") ? nextFile : o.properties.includes("createDirectory") ? EXPORT_TO : STEMS;
  return { canceled: false, filePaths: [pick] };
};

require(path.join(__dirname, "..", "..", "electron", "main.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How many bytes of two same-size screenshots differ visibly. GPU rendering
// varies by a level or two between frames, so "the same" means near zero, and
// "it moved" means a lot.
function visibleDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 8) n++;
  return n;
}
const looksSame = (a, b) => visibleDiff(a, b) < 50;
const looksDifferent = (a, b) => visibleDiff(a, b) > 500;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
};

async function run(win) {
  const wc = win.webContents;
  win.setIgnoreMouseEvents(true); // real mouse can't disturb the run; injected events still arrive
  // A covered window stops getting frames, which stalls input and screenshots.
  win.setAlwaysOnTop(true, "screen-saver");
  win.showInactive();
  wc.setBackgroundThrottling(false);
  const logs = [];
  wc.on("console-message", (_e, level, msg) => logs.push(`[${level}] ${msg}`));
  const js = (code) => wc.executeJavaScript(code);
  const shot = async (name) => {
    await sleep(350);
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  };
  const move = (x, y, modifiers = []) =>
    wc.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y), modifiers });
  const down = (x, y) =>
    wc.sendInputEvent({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
  const up = (x, y) =>
    wc.sendInputEvent({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
  const click = async (x, y) => {
    move(x, y);
    await sleep(40);
    down(x, y);
    await sleep(60);
    up(x, y);
    await sleep(180);
  };
  const text = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  const stems = () =>
    js(`Object.fromEntries([...document.querySelectorAll('.stem')].map(r=>[
      r.querySelector('.stem-label').textContent,
      {v:+r.querySelector('.stem-value').textContent, s:r.querySelector('.stem-status')?.textContent||''}]))`);
  const rect = () =>
    js(`(()=>{const r=document.querySelector('.stage-canvas').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);

  let taps = 0;
  ipcMain.on("haptics:tap", () => taps++);
  await sleep(2500);
  await shot("01-empty");
  const failed = (await text(".stage-caption"))?.includes("Couldn't");
  check("device model loads via IPC from file://", !failed, await text(".stage-caption"));

  // Find every control by sweeping the mouse and reading the hover caption.
  const r = await rect();
  const map = {};
  // What's under the pointer, read from the scene rather than the hint text.
  const PARTS = { Btn_Center: "Play / pause", Btn_Volume: "Master volume", Btn_Dots: "Jump 10s back / forward", Btn_Load: "Menu" };
  const hovered = async () => {
    const part = await js(`document.querySelector('.stage-canvas').dataset.part || ''`);
    return PARTS[part] || (part ? `${part} · ` : "");
  };
  const sweep = async (x, y) => {
    move(x, y);
    await sleep(55);
    return hovered();
  };
  const span = Math.min(r.w, r.h) * 0.92;
  const x0 = (r.w - span) / 2;
  const y0 = (r.h - span) / 2;
  for (let y = y0; y < y0 + span; y += 13) {
    for (let x = x0; x < x0 + span; x += 13) {
      const c = await sweep(r.x + x, r.y + y);
      const key = /^(vocals|drums|bass|instrumental) ·/.exec(c)?.[1] || (/^(Play|Master|Jump|Menu$)/.exec(c) ? c : null);
      if (!key) continue;
      (map[key] ||= []).push([r.x + x, r.y + y]);
    }
  }
  // The caption trails the pointer, so confirm a target before pressing it.
  const aim = async (pts, prefix) => {
    for (const p of pts) {
      move(...p);
      await sleep(130);
      if ((await hovered()).startsWith(prefix)) return p;
    }
    throw new Error(`no confirmed point for ${prefix}`);
  };
  const byCentre = (pts) => {
    const c = centre(pts);
    return pts.slice().sort((a, b) => Math.hypot(a[0] - c[0], a[1] - c[1]) - Math.hypot(b[0] - c[0], b[1] - c[1]));
  };
  const centre = (pts) => pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
  const where = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, centre(v)]));
  console.log("hit regions", JSON.stringify(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.length]))));
  for (const k of ["vocals", "drums", "bass", "instrumental"]) check(`groove reachable: ${k}`, !!where[k]);
  const key = (s) => Object.keys(where).find((k) => k.startsWith(s));
  console.log("edge buttons reachable head-on:", JSON.stringify(Object.keys(where).filter((k) => /Master|Jump|Menu/.test(k))));
  const stageShot = async (x = 0, w = r.w) =>
    (await wc.capturePage({ x: Math.round(r.x + x), y: Math.round(r.y), width: Math.round(w), height: Math.round(r.h - 70) })).toBitmap();

  // Plain pill toggles the panel, stems load through the normal button.
  const menuState = () => js(`document.querySelector('.drawer').classList.contains('drawer--open')`);
  check("menu starts closed", !(await menuState()));
  check("no corner meter before a song is loaded", !(await js(`!!document.querySelector('.meter')`)));
  const rightBefore = await stageShot(470, r.w - 470);
  await js(`document.querySelector('.menu-toggle').click()`);
  await sleep(350);
  check("opening the menu leaves the device fixed", looksSame(rightBefore, await stageShot(470, r.w - 470)));
  await shot("01b-menu-open");
  check("hamburger opens menu", await menuState());
  const centreY = (sel) => js(`(()=>{const r=document.querySelector('${sel}').getBoundingClientRect();return r.top+r.height/2})()`);
  const titleOff = Math.abs((await centreY(".menu-toggle")) - (await centreY(".title")));
  check("the menu title lines up with the close button", titleOff <= 1, `${titleOff.toFixed(1)}px apart`);
  await js(`document.querySelector('.drawer').scrollTop = 400`);
  await sleep(100);
  const titleOffScrolled = Math.abs((await centreY(".menu-toggle")) - (await centreY(".title")));
  check("and still lines up once the menu scrolls", titleOffScrolled <= 1, `${titleOffScrolled.toFixed(1)}px apart`);
  await js(`document.querySelector('.drawer').scrollTop = 0`);
  const byText = (t) => `[...document.querySelectorAll('.drawer button')].find(b=>b.textContent.includes(${JSON.stringify(t)}))`;
  const press = async (t) => {
    await js(`${byText(t)}.click()`);
    await sleep(300);
  };
  const disabled = (t) => js(`${byText(t)}.disabled`);
  const drawerText = () => js(`document.querySelector('.drawer').textContent`);
  const openMenu = async () => {
    if (!(await menuState())) await js(`document.querySelector('.menu-toggle').click()`);
    await sleep(400);
  };
  await shot("01c-empty-menu");
  check("Separate is disabled until a song is picked", await disabled("Separate"));
  check("no recents on first run", !(await js(`!!document.querySelector('.recent')`)));
  const label = await js(`(()=>{const r=[...document.querySelectorAll('.row-label')][1].getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
  for (const clickCount of [1, 2]) {
    wc.sendInputEvent({ type: "mouseDown", x: Math.round(label[0]), y: Math.round(label[1]), button: "left", clickCount });
    wc.sendInputEvent({ type: "mouseUp", x: Math.round(label[0]), y: Math.round(label[1]), button: "left", clickCount });
  }
  await sleep(200);
  check("double-clicking a label selects no text", (await js(`getSelection().toString()`)) === "", JSON.stringify(await js(`getSelection().toString()`)));
  check("no monospace text on the main screen", !(await js(`[...document.querySelectorAll('.readout *, .stage-caption, .stage-caption *')].some(e=>/mono|Menlo|Courier/i.test(getComputedStyle(e).fontFamily))`)));
  check("no all-caps eyebrow labels in the menu", !(await js(`[...document.querySelectorAll('.drawer *')].some(e=>getComputedStyle(e).textTransform==='uppercase')`)));
  await press("Choose…");
  check("picked song is shown", (await drawerText()).includes("tiny song.wav"));
  await shot("01d-ready");
  const foot = () => text(".section .footnote");
  check("recommendation names this Mac", (await foot()).startsWith("Recommended for your "), await foot());
  await press("CPU");
  check("choosing CPU explains the trade-off", (await foot()) === "The CPU is slower than the GPU, and makes the same stems.", await foot());
  await press("GPU");
  check("back on GPU it is recommended again", (await foot()).startsWith("Recommended for your "));
  await shot("01d2-settings");
  const procChecked = await js(`document.querySelector('[aria-label=Processor] [aria-checked=true]')?.textContent`);
  check("GPU is offered and selected by default", procChecked === "GPU", String(procChecked));
  const callsBefore = dialogCalls;
  await press("Separate");
  check("separating asks for no folder", dialogCalls === callsBefore, `${dialogCalls - callsBefore} extra`);
  await js(`document.querySelector('.menu-toggle').click()`);
  await sleep(1500);
  const during = await text(".readout-title");
  check("progress shows under the device with the menu closed", /^(Getting ready…|Separating “tiny song.wav”…) \d+%$/.test(during), during);
  check("no hint while separating", (await text(".stage-caption")) === "");
  let sawFallback = false;
  for (let i = 0; i < 240 && /^(Getting ready|Separating)/.test(await text(".readout-title")); i++) {
    if ((await drawerText()).includes("CPU is finishing this song")) sawFallback = true;
    await sleep(500);
  }
  if (process.env.FAIL_GPU) {
    check("a failed GPU run says it is finishing on the CPU", sawFallback);
    check("the menu remembers the switch afterwards", (await drawerText()).includes("finished on the CPU after a GPU problem"));
  } else {
    check("a working GPU run never falls back", !sawFallback);
  }
  await sleep(2500);
  check("separated song loads itself", (await text(".readout-title")) === "tiny song" && (await js(`document.querySelectorAll('.stem').length`)) === 4, await text(".readout-title"));
  const cacheDir = path.join(app.getPath("userData"), "stem-cache");
  const cached = fs.readdirSync(cacheDir);
  check("stems are in the private cache only", cached.length === 1 && fs.existsSync(path.join(cacheDir, cached[0], "stems", "vocals.wav")) && fs.readdirSync(EXPORT_TO).length === 0, cached.join());
  check("the song itself is not copied", !fs.readdirSync(path.join(cacheDir, cached[0])).some((f) => f.endsWith(".wav")));

  const timeOpen = async (fn) => {
    const t0 = Date.now();
    await fn();
    for (let i = 0; i < 100 && (await menuState()); i++) await sleep(50);
    return Date.now() - t0;
  };
  await openMenu();
  await shot("01e-recents");
  check("song appears under recents", (await js(`document.querySelectorAll('.recent').length`)) === 1 && (await text(".recent-quality")) === "Fast");
  const reopened = await timeOpen(() => js(`document.querySelector('.recent').click()`));
  check("a recent song reopens instantly", reopened < 2000 && (await text(".readout-title")) === "tiny song", `${reopened}ms`);

  await openMenu();
  nextFile = RENAMED;
  const renamed = await timeOpen(() => js(`document.querySelector('.choose').click()`));
  check("a renamed copy is recognised and opens instantly", renamed < 3000 && (await text(".readout-title")) === "tiny song", `${renamed}ms`);

  await openMenu();
  await press("Best");
  nextFile = SONG;
  await js(`document.querySelector('.choose').click()`);
  await sleep(700);
  check("Best is separate from Fast", await menuState());
  await press("Fast");
  const viaSeparate = await timeOpen(() => js(`${byText("Separate")}.click()`));
  check("Separate reuses a cached song", viaSeparate < 3000 && !(await menuState()), `${viaSeparate}ms`);
  check("nothing was separated twice", fs.readdirSync(cacheDir).length === 1);

  await openMenu();
  await press("Export Stems");
  await sleep(700);
  check("export writes the 4 stems", ["vocals", "drums", "bass", "instrumental"].every((n) => fs.existsSync(path.join(EXPORT_TO, "tiny song", `${n}.wav`))));
  await shot("01f-exported");
  await press("Export Stems");
  await sleep(700);
  check("a second export never replaces the first", fs.existsSync(path.join(EXPORT_TO, "tiny song (2)", "vocals.wav")));

  await press("Open Stems Folder");
  await sleep(2500);
  check("stems folder opens, menu closes itself", (await js(`document.querySelectorAll('.stem').length`)) === 4 && !(await menuState()));
  check("a stems folder is titled by its folder", (await text(".readout-title")) === STEMS_TITLE, await text(".readout-title"));
  await shot("02-loaded");

  // Groove drag sets only that stem, and doesn't touch the others.
  const pts = map.vocals.sort((a, b) => a[1] - b[1]);
  const outerPt = await aim(pts, "vocals");
  const inner = await aim(pts.slice().reverse(), "vocals");
  const mid = await aim(byCentre(pts), "vocals");
  move(...outerPt);
  await sleep(130);
  move(...outerPt);
  await sleep(40);
  down(...outerPt);
  for (let i = 1; i <= 14; i++) {
    move(outerPt[0] + ((inner[0] - outerPt[0]) * i) / 14, outerPt[1] + ((inner[1] - outerPt[1]) * i) / 14, ["leftButtonDown"]);
    await sleep(16);
  }
  up(...inner);
  await sleep(300);
  let s = await stems();
  check("drag inward lowers vocals only", s.vocals.v < 100 && s.drums.v === 100 && s.bass.v === 100 && s.instrumental.v === 100, JSON.stringify(s));
  check("dragging shows the new level", new RegExp(`^Vocals ${s.vocals.v}%$`).test(await text(".stage-caption")), await text(".stage-caption"));
  await shot("03-vocals-dragged");

  // Groove gestures, through real mouse input. Click mutes after the system
  // double-click interval; double-click, Option-click or holding the outer end
  // solos; a long press elsewhere does nothing.
  const dbl = await js(`window.api.getDoubleClickInterval()`);
  console.log(`double-click interval: ${dbl}ms`);
  const press1 = async (p, { clickCount = 1, modifiers = [], holdMs = 40 } = {}) => {
    wc.sendInputEvent({ type: "mouseDown", x: Math.round(p[0]), y: Math.round(p[1]), button: "left", clickCount, modifiers });
    await sleep(holdMs);
    wc.sendInputEvent({ type: "mouseUp", x: Math.round(p[0]), y: Math.round(p[1]), button: "left", clickCount, modifiers });
  };
  const settle = () => sleep(dbl + 250);
  const statusOf = async (stem) => (await stems())[stem].s;

  const before = s.vocals.v;
  const t0Taps = taps;
  move(...mid);
  await sleep(60);
  await press1(mid);
  await sleep(100);
  check("a click waits for a possible double-click", (await statusOf("vocals")) === "");
  await settle();
  s = await stems();
  check("a click mutes without moving the level", s.vocals.s === "muted" && s.vocals.v === before, JSON.stringify(s.vocals));
  check("muting says so", (await text(".stage-caption")) === "Vocals muted", await text(".stage-caption"));
  check("muting taps the trackpad", taps > t0Taps);
  await shot("04-muted");
  await press1(mid);
  await settle();
  check("a second click unmutes", (await statusOf("vocals")) === "");

  // Double-click anywhere solos, and never mutes along the way.
  await press1(mid, { clickCount: 1 });
  await sleep(90);
  await press1(mid, { clickCount: 2 });
  let mutedOnTheWay = false;
  for (let i = 0; i < 8; i++) {
    if ((await statusOf("vocals")) === "muted") mutedOnTheWay = true;
    await sleep(60);
  }
  check("a double-click solos", (await statusOf("vocals")) === "solo");
  check("a double-click never mutes on the way", !mutedOnTheWay);
  check("soloing says so", (await text(".stage-caption")) === "Vocals solo on", await text(".stage-caption"));
  await shot("05-solo");
  await press1(mid, { clickCount: 1 });
  await sleep(90);
  await press1(mid, { clickCount: 2 });
  await settle();
  check("a second double-click un-solos", (await statusOf("vocals")) === "");

  // Holding the outer end solos only while held, as on the hardware.
  const drums = map.drums.slice().sort((a, b) => b[0] - a[0]);
  const drumsEnd = await aim(drums, "drums");
  const drumsInner = await aim(drums.slice().reverse(), "drums");
  const holdDown = async (p) => {
    move(...p);
    await sleep(60);
    wc.sendInputEvent({ type: "mouseDown", x: Math.round(p[0]), y: Math.round(p[1]), button: "left", clickCount: 1 });
  };
  const holdUp = (p) =>
    wc.sendInputEvent({ type: "mouseUp", x: Math.round(p[0]), y: Math.round(p[1]), button: "left", clickCount: 1 });
  await holdDown(drumsEnd);
  await sleep(650);
  check("holding the outer end solos while held", (await statusOf("drums")) === "solo");
  check("the hold says it's temporary", (await text(".stage-caption")) === "Drums solo while held", await text(".stage-caption"));
  await sleep(1500);
  check("the solo lasts as long as the hold", (await statusOf("drums")) === "solo");
  holdUp(drumsEnd);
  await sleep(200);
  s = await stems();
  check("letting go puts all four stems back", Object.values(s).every((x) => x.s === ""), JSON.stringify(s));

  // A hold on top of a lasting solo puts that solo back afterwards.
  await press1(mid, { clickCount: 1 });
  await sleep(90);
  await press1(mid, { clickCount: 2 });
  await settle();
  await holdDown(drumsEnd);
  await sleep(650);
  s = await stems();
  check("holding another stem adds it to the solo", s.vocals.s === "solo" && s.drums.s === "solo", JSON.stringify(s));
  holdUp(drumsEnd);
  await sleep(200);
  s = await stems();
  check("letting go keeps the earlier solo", s.vocals.s === "solo" && s.drums.s === "", JSON.stringify(s));
  await press1(mid, { modifiers: ["alt"] });
  await sleep(150);
  check("Option-click ends that solo", (await statusOf("vocals")) === "");

  // A muted stem held to listen goes back to muted.
  await press1(drumsEnd);
  await settle();
  check("drums muted", (await statusOf("drums")) === "muted");
  await holdDown(drumsEnd);
  await sleep(650);
  check("a muted stem can be held to hear it", (await statusOf("drums")) === "solo");
  holdUp(drumsEnd);
  await sleep(200);
  check("and is muted again on release", (await statusOf("drums")) === "muted");
  await press1(drumsEnd);
  await settle();
  check("drums unmuted", (await statusOf("drums")) === "");

  move(...drumsInner);
  await sleep(60);
  await press1(drumsInner, { holdMs: 650 });
  await settle();
  check("a long press away from the end does nothing", (await statusOf("drums")) === "");

  // Option-click solos at once.
  const bassPts = map.bass;
  const bassMid = await aim(byCentre(bassPts), "bass");
  await press1(bassMid, { modifiers: ["alt"] });
  await sleep(150);
  check("Option-click solos straight away", (await statusOf("bass")) === "solo");
  await press1(bassMid, { modifiers: ["alt"] });
  await sleep(150);
  check("Option-click again un-solos", (await statusOf("bass")) === "");

  // With "tap to click", a resting finger arrives as a quick click.
  await press1(drumsEnd, { holdMs: 15 });
  await settle();
  check("a tap-to-click press is a click, so it mutes", (await statusOf("drums")) === "muted");
  await press1(drumsEnd);
  await settle();

  // Quick clicks on two grooves are two mutes.
  await press1(mid);
  await sleep(120);
  await press1(drumsEnd);
  await settle();
  s = await stems();
  check("quick clicks on two grooves mute both", s.vocals.s === "muted" && s.drums.s === "muted", JSON.stringify(s));
  await press1(mid);
  await sleep(120);
  await press1(drumsEnd);
  await settle();
  s = await stems();
  check("and quick clicks again unmute both", s.vocals.s === "" && s.drums.s === "", JSON.stringify(s));

  // Centre button plays and pauses.
  const t0 = await text(".readout span:last-child");
  const playPt = await aim(byCentre(map[key("Play")]), "Play");
  await click(...playPt);
  await sleep(1400);
  const t1 = await text(".readout span:last-child");
  check("centre button plays", t0 !== t1, `${t0} -> ${t1}`);

  // Rows bounce with their stem while the menu is open; a muted stem stays still.
  await openMenu();
  await js(`[...document.querySelectorAll('.stem-controls button')].find(b=>b.getAttribute('aria-label')==='Mute bass').click()`);
  await sleep(500);
  const scaleOf = (sel, i) => js(`(()=>{const t=getComputedStyle(document.querySelectorAll('${sel}')[${i}]).transform;return t==='none'?1:new DOMMatrix(t).${sel === ".stem-dot" ? "a" : "d"}})()`);
  let drumsMax = 1, bassMax = 1, waveMax = 1;
  for (let i = 0; i < 12; i++) {
    drumsMax = Math.max(drumsMax, await scaleOf(".stem-dot", 1));
    bassMax = Math.max(bassMax, await scaleOf(".stem-dot", 2));
    waveMax = Math.max(waveMax, await scaleOf(".wave", 1));
    await sleep(40);
  }
  check("a playing stem's dot bounces", drumsMax > 1.05, drumsMax.toFixed(3));
  check("its waveform bounces too", waveMax > 1.01, waveMax.toFixed(3));
  check("a muted stem stays still", bassMax < 1.01, bassMax.toFixed(3));
  await js(`[...document.querySelectorAll('.stem-controls button')].find(b=>b.getAttribute('aria-label')==='Mute bass').click()`);
  await js(`document.querySelector('.menu-toggle').click()`);
  await sleep(400);

  // The corner meter: one style at a time, chosen in the menu, live with it closed.
  check("the corner itself has no controls", (await js(`document.querySelectorAll('.meter button').length`)) === 0);
  await openMenu();
  const switchLabels = await js(`[...document.querySelectorAll('[aria-label="Level meter style"] button')].map(b=>b.textContent).join('|')`);
  check("the menu offers exactly Dots, Waveform or Off", switchLabels === "Dots|Waveform|Off", switchLabels);
  await js(`document.querySelector('.menu-toggle').click()`);
  await sleep(400);
  let cornerDot = 1;
  for (let i = 0; i < 12; i++) {
    cornerDot = Math.max(cornerDot, await scaleOf(".meter-dot", 1));
    await sleep(40);
  }
  check("corner dots bounce with the menu closed", cornerDot > 1.05, cornerDot.toFixed(3));
  await openMenu();
  await press("Waveform");
  await js(`document.querySelector('.menu-toggle').click()`);
  await sleep(500);
  check("Waveform shows four waveforms and no dots", (await js(`document.querySelectorAll('.meter-wave').length`)) === 4 && (await js(`document.querySelectorAll('.meter-dot').length`)) === 0);
  let cornerWave = 1;
  for (let i = 0; i < 12; i++) {
    cornerWave = Math.max(cornerWave, await scaleOf(".meter-wave .wave", 1));
    await sleep(40);
  }
  check("corner waveforms bounce", cornerWave > 1.01, cornerWave.toFixed(3));
  await shot("05a-corner-wave");
  check("the choice is remembered", (await js(`localStorage.getItem('stem-player.meter-style')`)) === "wave");
  await openMenu();
  await press("Dots");
  await js(`document.querySelector('.menu-toggle').click()`);
  await sleep(400);
  await click(...playPt);
  await sleep(300);
  await openMenu();
  check("rows settle when playback stops", (await scaleOf(".stem-dot", 1)) === 1);
  check("the corner settles too", (await scaleOf(".meter-dot", 1)) === 1);

  // Beat taps: off until chosen, then on the drums' 2 Hz pulse, quiet with the drums muted.
  const beatTapsChoice = () => js(`document.querySelector('[aria-label="Beat taps"] [aria-checked="true"]').textContent`);
  const chooseBeatTaps = (label) => js(`[...document.querySelectorAll('[aria-label="Beat taps"] button')].find(b=>b.textContent==='${label}').click()`);
  const muteDrums = () => js(`[...document.querySelectorAll('.stem-controls button')].find(b=>b.getAttribute('aria-label')==='Mute drums').click()`);
  // Counts only the taps between starting and stopping, not the play button's own.
  const tapsWhilePlaying = async (ms) => {
    await js(`document.querySelector('.menu-toggle').click()`);
    await sleep(400);
    await click(...playPt);
    await sleep(250);
    const from = taps;
    await sleep(ms);
    const n = taps - from;
    await click(...playPt);
    await sleep(300);
    await openMenu();
    return n;
  };
  check("beat taps start off", (await beatTapsChoice()) === "Off", await beatTapsChoice());
  let beatTaps = await tapsWhilePlaying(2000);
  check("no beat taps while they're off", beatTaps === 0, `${beatTaps}`);
  await chooseBeatTaps("On");
  beatTaps = await tapsWhilePlaying(2000);
  check("beat taps follow the drums' pulse", beatTaps >= 3 && beatTaps <= 6, `${beatTaps} in 2s`);
  const drumsVolume = (v) =>
    js(`(()=>{const el=document.querySelector('input[aria-label="drums volume"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'${v}');el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await drumsVolume(0.4);
  beatTaps = await tapsWhilePlaying(2000);
  check("at 40% volume only the loud hits tap", beatTaps >= 1 && beatTaps <= 3, `${beatTaps} in 2s`);
  await drumsVolume(0.04);
  beatTaps = await tapsWhilePlaying(2000);
  check("near silent drums don't tap", beatTaps === 0, `${beatTaps}`);
  await drumsVolume(1);
  await muteDrums();
  beatTaps = await tapsWhilePlaying(2000);
  check("muted drums stop the beat taps", beatTaps === 0, `${beatTaps}`);
  await muteDrums();
  check("the beat taps choice is remembered", (await js(`localStorage.getItem('stem-player.beat-taps')`)) === "on");
  await chooseBeatTaps("Off");

  await js(`document.querySelector('.menu-toggle').click()`);
  await sleep(400);

  // Double tap on the background resets; a single tap, or one on the body, doesn't.
  await sleep(600);
  const homeShot = await stageShot();
  const homePng = async (name) =>
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await wc.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h - 70) })).toPNG());
  await homePng("05b-home");
  const bg = [r.x + r.w * 0.08, r.y + r.h * 0.5];
  const dragFrom = async (p, dx, dy) => {
    move(...p);
    await sleep(60);
    down(...p);
    for (let i = 1; i <= 14; i++) {
      move(p[0] + (dx * i) / 14, p[1] + (dy * i) / 14, ["leftButtonDown"]);
      await sleep(16);
    }
    up(p[0] + dx, p[1] + dy);
    await sleep(250);
  };
  const doubleTap = async (p) => {
    move(...p);
    await sleep(60);
    for (let i = 0; i < 2; i++) {
      down(...p);
      await sleep(30);
      up(...p);
      await sleep(70);
    }
    await sleep(1100);
  };
  check("no reset hint at home", (await text(".stage-caption")) !== "Double-click the background to reset");
  await dragFrom(bg, -42, -42);
  check("drag from the background turns it", looksDifferent(homeShot, await stageShot()));
  check("turning shows how to reset", (await text(".stage-caption")) === "Double-click the background to reset", await text(".stage-caption"));
  await click(...bg);
  await sleep(700);
  check("single background tap does not reset", looksDifferent(homeShot, await stageShot()));
  // A spot on the turned body that is no control at all.
  let bodyPt = null;
  for (const [dx, dy] of [[90, 90], [-90, 90], [90, -90], [-90, -90], [130, 40], [-130, -40]]) {
    const p = [r.x + r.w / 2 + dx, r.y + r.h / 2 + dy];
    if ((await sweep(...p)) === "") {
      bodyPt = p;
      break;
    }
  }
  const levelsBeforeBodyTap = JSON.stringify(await stems());
  await doubleTap(bodyPt);
  check("double tap on the body does not reset", looksDifferent(homeShot, await stageShot()));
  check("double tap on the body changes no stem", JSON.stringify(await stems()) === levelsBeforeBodyTap);
  await shot("05c-turned");
  await doubleTap(bg);
  await homePng("05d-after-reset");
  check("double tap on the background resets exactly", looksSame(homeShot, await stageShot()));
  check("the reset hint goes away at home", (await text(".stage-caption")) !== "Double-click the background to reset");

  check("edge buttons reachable head-on", !!(key("Master") && key("Jump") && key("Menu")));

  // Pill ends: − left, + right; jump back / forward.
  const vol = () => text(".readout span:nth-child(2)");
  const pill = map[key("Master")].slice().sort((a, b) => a[0] - b[0]);
  const v0 = await vol();
  await click(...(await aim(pill, "Master")));
  const v1 = await vol();
  const v2start = v1;
  await click(...(await aim(pill.slice().reverse(), "Master")));
  const v2 = await vol();
  check("volume pill: left lowers, right raises", v0 !== v1 && v2 !== v1, `${v0} ${v2start} ${v2}`);

  const dots = map[key("Jump")].slice().sort((a, b) => a[0] - b[0]);
  const timeNow = () => text(".readout span:last-child");
  await click(...(await aim(dots.slice().reverse(), "Jump")));
  const j1 = await timeNow();
  await click(...(await aim(dots, "Jump")));
  const j2 = await timeNow();
  check("dot pill jumps back and forward", j1 !== j2, `${j1} -> ${j2}`);

  // Holding a pill keeps going: the dots scrub, − / + keep stepping.
  const hold = async (p, ms, during) => {
    move(...p);
    await sleep(40);
    down(...p);
    await sleep(ms);
    const seen = during ? await during() : null;
    up(...p);
    await sleep(250);
    return seen;
  };
  const secs = (readout) => {
    const [m, s] = readout.split(" / ")[0].split(":").map(Number);
    return m * 60 + s;
  };
  const fwdPt = await aim(dots.slice().reverse(), "Jump");
  const backPt = await aim(dots, "Jump");
  const h0 = secs(await timeNow());
  const scrubTaps0 = taps;
  const scrubCaption = await hold(fwdPt, 1500, () => text(".stage-caption"));
  const h1 = secs(await timeNow());
  check("holding forward scrubs well past one jump", h1 - h0 >= 12 && h1 < 45, `${h0}s -> ${h1}s`);
  check("the caption follows the scrub", /^Forward to \d+:\d\d$/.test(scrubCaption), scrubCaption);
  check("the scrub taps as it passes each 10 seconds", taps - scrubTaps0 >= 2, `${taps - scrubTaps0}`);
  await sleep(600);
  const h1later = secs(await timeNow());
  check("letting go stops the scrub", h1later - h1 <= 2, `${h1}s -> ${h1later}s`);
  await hold(backPt, 1500);
  const h2 = secs(await timeNow());
  check("holding back scrubs back", h1later - h2 >= 12, `${h1later}s -> ${h2}s`);
  await hold(backPt, 3000);
  check("scrubbing back stops at the start", secs(await timeNow()) <= 1, await timeNow());

  const pct = async () => Number((await vol()).match(/(\d+)%/)[1]);
  const volLeft = await aim(pill, "Master");
  const volRight = await aim(pill.slice().reverse(), "Master");
  const vh0 = await pct();
  await hold(volLeft, 1300);
  const vh1 = await pct();
  check("holding − keeps lowering the volume", vh0 - vh1 >= 40, `${vh0}% -> ${vh1}%`);
  await hold(volRight, 2500);
  check("holding + raises it back to the top", (await pct()) === 100, `${await pct()}%`);

  // Load pill opens the panel and back returns to the stems.
  const loadPt = await aim(byCentre(map[key("Menu")]), "Menu");
  await click(...loadPt);
  check("plain pill opens menu", await menuState());
  await click(...loadPt);
  await sleep(300);
  check("plain pill closes menu", !(await menuState()));

  // Waveform scrub still works and doesn't touch the levels.
  await js(`document.querySelector('.menu-toggle').click()`);
  await sleep(350);
  const offscreen = await js(`document.querySelector('.wave-wrap').getBoundingClientRect().bottom > innerHeight`);
  console.log("first waveform below the fold before scrolling:", offscreen);
  await js(`document.querySelector('.wave-wrap').scrollIntoView({block:'center'})`);
  await sleep(200);
  const w = await js(`(()=>{const r=document.querySelector('.wave-wrap').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  const tBefore = await timeNow();
  await click(w.x + w.w * 0.6, w.y + w.h / 2);
  const tAfter = await timeNow();
  check("waveform scrub seeks", tBefore !== tAfter, `${tBefore} -> ${tAfter}`);

  // Keyboard stand-ins exist and are focusable.
  const focusable = await js(`(()=>{const a=[...document.querySelectorAll('.kbd-controls button, .stem-controls input, .stem-controls button')];a.forEach(e=>e.focus());return a.filter(e=>{e.focus();return document.activeElement===e}).length})()`);
  check("keyboard controls focusable", focusable === 17, `${focusable}/17`);

  await shot("10-menu-with-stems");
  wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await sleep(350);
  check("Escape closes menu", !(await menuState()));
  await shot("11-final");

  // Dragging from outside the grooves turns the device, and it stays put.
  const levels = JSON.stringify(await stems());
  const grab = async () => (await wc.capturePage()).toBitmap();
  const c = [r.x + r.w * 0.1, r.y + r.h * 0.5];
  const before360 = await grab();
  const turn = async (dx, dy, name) => {
    move(...c);
    await sleep(60);
    down(...c);
    for (let i = 1; i <= 18; i++) {
      move(c[0] + (dx * i) / 18, c[1] + (dy * i) / 18, ["leftButtonDown"]);
      await sleep(16);
    }
    up(c[0] + dx, c[1] + dy);
    await sleep(200);
    await shot(name);
  };
  await turn(120, 0, "12-turned");
  const afterRelease = await grab();
  await sleep(1200);
  const later = await grab();
  check("drag turns the device", looksDifferent(before360, afterRelease));
  check("device stays where it was released", looksSame(afterRelease, later));
  check("turning changes no levels", JSON.stringify(await stems()) === levels);
  await turn(0, 175, "13-back");
  await turn(-90, -70, "14-edge");
  await shot("15-final");
  const pageBefore = wc.getURL();
  const gh = await js(`(()=>{const r=document.querySelector('.social a[aria-label="GitHub repository"]').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
  await click(...gh);
  await sleep(500);
  check("GitHub opens the repo in the browser", opened.includes("https://github.com/PravdeepK/stem-player"), JSON.stringify(opened));
  check("the app window stays put", wc.getURL() === pageBefore);
  await doubleTap(bg);
  const bx = c[0];
  move(bx, c[1]);
  await sleep(60);
  down(bx, c[1]);
  for (let i = 1; i <= 35; i++) {
    move(bx + i * 10, c[1], ["leftButtonDown"]);
    await sleep(16);
  }
  up(bx + 350, c[1]);
  await shot("17-back-face");
  console.log("--- console errors");
  console.log(logs.filter((l) => /^\[(2|3)\]/.test(l)).join("\n") || "none");
  const failedCount = results.filter((x) => !x.ok).length;
  console.log(`\nscreenshots: ${OUT}`);
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
    app.exit(failed ? 1 : 0);
  }, 200);
  setTimeout(() => {
    console.error("timeout");
    app.exit(1);
  }, 480000);
});
