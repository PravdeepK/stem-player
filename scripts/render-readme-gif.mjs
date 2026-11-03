// Renders docs/media/stem-player.gif, the README's hero image: the real device
// scene (lib/deviceScene.js with assets/models/stem-player.glb) tumbling in
// headless Chromium, its LEDs pulsing in the stem colours as if a song were on.
//
//   npm run readme:gif   [-- --keep-frames]
//
// HOW THE DEVICE IS TURNED
// The same way a person turns it: one long pointer drag that starts on the
// background, dispatched on the canvas. deviceScene only knows drags, and a
// drag only spins the device about the screen's X and Y axes, so each frame's
// change of pose is split into three drag segments, sideways, up/down and
// sideways again (a Y-X-Y Euler decomposition), which reaches any orientation,
// roll included. The scene is left untouched; the harness only watches it, by
// noting which scene the renderer draws, to read the pose actually reached.
//
// THE MOTION
// Someone fidgeting with it in their hand, not a turntable: a small physics
// model (see "the hand" below) integrates a quaternion from an angular
// velocity. A wind-up and a big flick that coasts past a full turn, a catch
// with a little overshoot, a quick flick that friction stops, a sideways roll,
// a slow turn to look at the back, then it is put back down head-on and
// settles. Pauses carry a faint hand tremor. A fixed seed shifts the timings,
// speeds and axes, so it is irregular but reproducible. It starts and ends at
// rest in the home pose, so the last frame runs into the first; the LED
// levels are periodic over the loop too.
//
// FRAMES
// Stepped, not recorded: requestAnimationFrame is swapped for a queue this
// script flushes once per frame with a fixed timestamp, then screenshots the
// middle of the canvas at 2x. ffmpeg downscales and builds one palette for the
// whole loop; sierra3 dithering keeps the body's gradients and the LED glows
// from banding and compresses better than the lighter dithers.

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "media", "stem-player.gif");
const FFMPEG = process.env.FFMPEG || (existsSync("/usr/local/bin/ffmpeg") ? "/usr/local/bin/ffmpeg" : "ffmpeg");

const SIZE = 520; // output px, square
const SUPERSAMPLE = 2; // rendered at 2x, then downscaled
// The scene frames the device loosely for an app window; the GIF keeps the
// middle of a larger canvas so the device fills more of it.
const CROP = 0.82;
const VIEW = Math.round(SIZE / CROP); // canvas px
const FPS = 25;
const SECONDS = 9.0;
const FRAMES = Math.round(FPS * SECONDS);
const SEED = 20261103;
// Frames run before capture so the LEDs' easing has settled into the loop.
const WARMUP = 30;

const KEEP_FRAMES = process.argv.includes("--keep-frames");

// The app's colours, read from the stylesheet the way DeviceStage reads them.
const css = readFileSync(path.join(ROOT, "styles", "globals.css"), "utf8");
const cssVar = (name) => {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`--${name} not found in styles/globals.css`);
  return m[1].trim();
};
const STEMS = ["vocals", "drums", "bass", "instrumental"];
const stemColors = Object.fromEntries(STEMS.map((n) => [n, cssVar(`zone-${n}`)]));
const background = cssVar("bg");

// --- page ------------------------------------------------------------------

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({
  imports: {
    three: "/node_modules/three/build/three.module.js",
    "three/examples/jsm/": "/node_modules/three/examples/jsm/",
  },
})}</script>
<style>
  html, body { margin: 0; background: ${background}; overflow: hidden; }
  #stage { width: ${VIEW}px; height: ${VIEW}px; }
  canvas { display: block; width: 100%; height: 100%; }
</style>
</head><body><div id="stage"><canvas></canvas></div>
<script type="module" src="/__harness.js"></script>
</body></html>`;

const HARNESS = `
import * as THREE from "three";

// Frames happen when the script says so: queue the scene's frame requests and
// run them from step(), with a timestamp that advances exactly 1/FPS.
let nextId = 1;
let queue = new Map();
window.requestAnimationFrame = (cb) => (queue.set(nextId, cb), nextId++);
window.cancelAnimationFrame = (id) => queue.delete(id);
function flush(now) {
  const due = queue;
  queue = new Map();
  for (const cb of due.values()) cb(now);
}

// Watch, don't touch: note what the renderer draws, to read the device's pose.
let drawn = null;
// (The renderer's methods are per instance, but every render calls this hook.)
THREE.Scene.prototype.onBeforeRender = function (renderer, scene, camera) {
  drawn = { scene, camera, gl: renderer.getContext() };
};

const { createDeviceScene } = await import("/lib/deviceScene.js");
const { FPS, FRAMES, SEED, stemColors } = window.__config;

const canvas = document.querySelector("canvas");
const bytes = await (await fetch("/assets/models/stem-player.glb")).arrayBuffer();
const noop = () => {};
const actions = {
  onTap: noop, onHoldStart: noop, onHoldEnd: noop, onGrooveMute: noop, onGrooveSolo: noop,
  onGrooveHoldStart: noop, onGrooveHoldEnd: noop, onGrooveDrag: noop,
  getStemVolume: () => 1, onHover: noop, onTurned: noop,
};
const device = await createDeviceScene(canvas, bytes, stemColors, actions, { doubleClickMs: 350 });
flush(1000 / FPS);
const root = drawn.scene.children.find((o) => o.isGroup);
const HOME = root.quaternion.clone();

// --- the hand ---------------------------------------------------------------
// A small physics model of someone fidgeting with the device. Orientation is a
// quaternion integrated from a world-space angular velocity. The hand is
// either holding it (a spring towards where the hand wants it, which may
// itself move) or has let go after a flick (the push spins it up over a few
// hundredths of a second, then friction bleeds the speed off exponentially).
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const jiggle = (x, by) => x * (1 + (rand() * 2 - 1) * by);
const nudge = (x, by) => x + (rand() * 2 - 1) * by;
const V = (x, y, z) => new THREE.Vector3(nudge(x, 0.12), nudge(y, 0.12), nudge(z, 0.12)).normalize();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const q = (axis, angle) => new THREE.Quaternion().setFromAxisAngle(axis, angle);
const LOOP = FRAMES / FPS;
const smoother = (s) => (s <= 0 ? 0 : s >= 1 ? 1 : s * s * s * (s * (6 * s - 15) + 10));

// The routine, in seconds. Axes are world space: x across the screen, y up it,
// z out of it. The seed shifts every time, speed and axis a little.
const at = (t) => nudge(t, 0.06);
const firstFlick = V(0.28, 1, 0.12);
const ROUTINE = [
  { at: 0, hold: { k: 200, zeta: 1 } },
  // Grab, a little wind-up the other way, then a big flick that coasts past a full turn.
  { at: at(0.5), windup: { axis: firstFlick, angle: -0.28, time: 0.3 } },
  { at: at(0.8), flick: { axis: firstFlick, speed: jiggle(8.2, 0.06), rise: 0.1, friction: 0.8 } },
  { at: at(2.45), catch: { lead: 0.045, k: 320, zeta: 0.38 } },
  // Held, then a quick small flick that friction stops on its own.
  { at: at(3.1), flick: { axis: V(1, -0.25, 0.3), speed: jiggle(5.6, 0.08), rise: 0.06, friction: 6 } },
  { at: at(3.7), catch: { lead: 0.1, k: 90, zeta: 0.95 } },
  // A sideways roll, caught.
  { at: at(4.1), flick: { axis: V(0.15, 0.2, 1), speed: jiggle(7.5, 0.06), rise: 0.08, friction: 2.2 } },
  { at: at(4.9), catch: { lead: 0.04, k: 300, zeta: 0.42 } },
  // A slow, deliberate turn to look at the back, and a moment there.
  { at: at(5.5), turn: { axis: V(-0.1, 1, 0.08), angle: jiggle(2.7, 0.05), time: 1.4, k: 140, zeta: 0.85 } },
  // Turned back over and put down head-on, with a small settle, and left there.
  { at: at(7.35), putBack: { time: 1.15, k: 170, zeta: 0.5 } },
];
// Hand tremor, while held: slow, tiny, never quite still.
const JITTER_RAD = 0.009;
const jitterFrom = ROUTINE[1].at + 0.15;
const jitterTo = ROUTINE[ROUTINE.length - 1].at + 0.6;

// Shortest rotation vector taking a to b (world space), angle times axis.
function rotationVector(a, b) {
  const d = b.clone().multiply(a.clone().invert());
  if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
  const s = Math.hypot(d.x, d.y, d.z);
  if (s < 1e-12) return new THREE.Vector3();
  const angle = 2 * Math.atan2(s, d.w);
  return new THREE.Vector3(d.x, d.y, d.z).multiplyScalar(angle / s);
}

function begin(step, pose, spin, start) {
  const spring = (anchorAt, k, zeta) => (time) =>
    rotationVector(pose, anchorAt(time)).multiplyScalar(k).addScaledVector(spin, -2 * zeta * Math.sqrt(k));
  const from = pose.clone();
  if (step.hold) return spring(() => from, step.hold.k, step.hold.zeta);
  if (step.windup || step.turn) {
    const { axis, angle, time, k = 220, zeta = 0.9 } = step.windup || step.turn;
    return spring((t) => q(axis, angle * smoother((t - start) / time)).multiply(from), k, zeta);
  }
  if (step.catch) {
    // Caught a touch ahead of where it was, so it overshoots and settles back.
    const { lead, k, zeta } = step.catch;
    const speed = spin.length();
    const anchor = speed ? q(spin.clone().normalize(), speed * lead).multiply(from) : from;
    return spring(() => anchor, k, zeta);
  }
  if (step.putBack) {
    const { time, k, zeta } = step.putBack;
    return spring((t) => from.clone().slerp(HOME, smoother((t - start) / time)), k, zeta);
  }
  const { axis, speed, rise, friction } = step.flick;
  // A sin² push whose integral is the flick's speed, then friction.
  return (t) => {
    const s = (t - start) / rise;
    const push = s < 1 ? ((2 * speed) / rise) * Math.sin(Math.PI * s) ** 2 : 0;
    return axis.clone().multiplyScalar(push).addScaledVector(spin, -friction);
  };
}

const SUBSTEPS = 16;
function simulate() {
  const dt = 1 / (FPS * SUBSTEPS);
  const pose = HOME.clone();
  const spin = new THREE.Vector3();
  const track = [];
  let next = 0;
  let accel = null;
  for (let i = 0; i < FRAMES * SUBSTEPS; i++) {
    const time = i * dt;
    if (i % SUBSTEPS === 0) track.push({ pose: pose.clone(), speed: spin.length() });
    while (next < ROUTINE.length && time >= ROUTINE[next].at) accel = begin(ROUTINE[next++], pose, spin, time);
    spin.addScaledVector(accel(time), dt);
    const angle = spin.length() * dt;
    if (angle) pose.premultiply(q(spin.clone().normalize(), angle)).normalize();
  }
  // Where frame FRAMES (= frame 0 again) would be: should be home, at rest.
  const endError = pose.angleTo(HOME);
  // The settle leaves it a hair off; ease the last moments of the rest onto
  // home exactly, so the loop closes without even a sub-pixel step.
  track.forEach((frame, i) => {
    const w = smoother((i / FPS - (LOOP - 0.4)) / 0.3);
    if (w > 0) frame.pose.slerp(HOME, w);
  });
  return { track, endError, endSpeed: spin.length() };
}
const { track, endError, endSpeed } = simulate();

// Tremor: smooth value noise on each axis, faded in after the grab and out
// once it's been put down, so the loop point is perfectly still.
const knots = [0, 1, 2].map(() => Array.from({ length: Math.ceil(LOOP / 0.32) + 4 }, () => rand() * 2 - 1));
function noise(axis, t) {
  const k = knots[axis];
  const x = t / 0.32;
  const i = Math.floor(x);
  const f = x - i;
  const [p0, p1, p2, p3] = [k[i], k[i + 1], k[i + 2], k[i + 3]];
  return 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
}
function tremor(t) {
  const fade = smoother((t - jitterFrom) / 0.4) * (1 - smoother((t - jitterTo) / 0.4));
  const v = new THREE.Vector3(noise(0, t), noise(1, t), noise(2, t)).multiplyScalar(JITTER_RAD * fade);
  const angle = v.length();
  return angle ? q(v.normalize(), angle) : new THREE.Quaternion();
}

function poseAt(frame) {
  const f = ((frame % FRAMES) + FRAMES) % FRAMES;
  return tremor(f / FPS).multiply(track[f].pose);
}

// LED levels as if a song were playing: drums on every beat, bass on every
// other, vocals and the rest drifting. Whole bars per loop, so it loops.
const TAU = Math.PI * 2;
const BEATS = 2 * Math.round(LOOP);
function drift(harmonics) {
  const terms = harmonics.map((k) => ({ k, amp: 0.5 + rand(), phase: rand() * TAU }));
  const norm = 1 / terms.reduce((s, x) => s + x.amp, 0);
  return (t) => terms.reduce((s, x) => s + norm * x.amp * Math.sin(TAU * x.k * t + x.phase), 0);
}
const hit = (t, per, decay) => Math.exp(-((((t * per) % 1) + 1) % 1) * decay);
const swell = drift([2, 3, 5]);
const pad = drift([1, 2, 4]);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
function levelsAt(frame) {
  const t = ((((frame / FRAMES) % 1) + 1) % 1);
  return {
    drums: { volume: clamp01(0.3 + 0.7 * hit(t, BEATS, 4.5)), glow: 1 },
    bass: { volume: clamp01(0.4 + 0.55 * hit(t + 0.25 / BEATS, BEATS / 2, 2.2)), glow: 1 },
    vocals: { volume: clamp01(0.62 + 0.3 * swell(t) + 0.06 * Math.sin(TAU * BEATS * t)), glow: 1 },
    instrumental: { volume: clamp01(0.7 + 0.25 * pad(t)), glow: 1 },
  };
}

// --- the drag -----------------------------------------------------------------
// TURN_RAD_PER_PX in lib/deviceScene.js. Only the gain: the pose is re-read
// from the scene every frame, so any error is corrected on the next one.
const RAD_PER_PX = 0.009;
const pointer = { x: 3, y: 3 }; // a background corner, well off the device
function send(type) {
  canvas.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: pointer.x, clientY: pointer.y,
      bubbles: true, cancelable: true, composed: true,
    })
  );
}
function dragBy(dx, dy) {
  pointer.x += dx;
  pointer.y += dy;
  send("pointermove");
}
send("pointerdown");
// Past the tap slop and straight back, so the drag counts as a turn.
dragBy(12, 0);
dragBy(-12, 0);

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// Drag the device from its current pose to target: delta = Ry(a) Rx(b) Ry(c).
function turnTo(target) {
  const delta = target.clone().multiply(root.quaternion.clone().invert()).normalize();
  const up = Y.clone().applyQuaternion(delta);
  const b = Math.acos(Math.min(1, Math.max(-1, up.y)));
  const a = Math.hypot(up.x, up.z) < 1e-9 ? 0 : Math.atan2(up.x, up.z);
  const rest = q(X, -b).multiply(q(Y, -a)).multiply(delta);
  const c = wrap(2 * Math.atan2(rest.y, rest.w));
  dragBy(c / RAD_PER_PX, 0);
  dragBy(0, b / RAD_PER_PX);
  dragBy(wrap(a) / RAD_PER_PX, 0);
}

// Every vertex of the device, in the turning group's own space, to check the
// framing: none may leave the canvas at any pose.
const points = [];
root.updateMatrixWorld(true);
const toRoot = root.matrixWorld.clone().invert();
root.traverse((o) => {
  if (!o.isMesh || !o.visible || o.material.visible === false || !o.geometry.attributes.position) return;
  const pos = o.geometry.attributes.position;
  const m = toRoot.clone().multiply(o.matrixWorld);
  const step = Math.max(1, Math.floor(pos.count / 4000));
  for (let i = 0; i < pos.count; i += step) points.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m));
});
function extent() {
  const { camera } = drawn;
  root.updateMatrixWorld(true);
  let max = 0;
  const v = new THREE.Vector3();
  for (const p of points) {
    v.copy(p).applyMatrix4(root.matrixWorld).project(camera);
    max = Math.max(max, Math.abs(v.x), Math.abs(v.y));
  }
  return max;
}

let maxError = 0;
let maxExtent = 0;
window.__step = (frame) => {
  device.setLevels(levelsAt(frame));
  const target = poseAt(frame);
  turnTo(target);
  flush((frame + 100) * (1000 / FPS));
  maxError = Math.max(maxError, root.quaternion.angleTo(target));
  maxExtent = Math.max(maxExtent, extent());
};
window.__stats = () => {
  const dbg = drawn.gl.getExtension("WEBGL_debug_renderer_info");
  return {
    gpu: dbg ? drawn.gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : drawn.gl.getParameter(drawn.gl.RENDERER),
    maxPoseErrorDeg: (maxError * 180) / Math.PI,
    maxExtent,
    endErrorDeg: (endError * 180) / Math.PI,
    endSpeed,
    speeds: track.map((x) => x.speed),
  };
};
window.__ready = true;
`;

// --- tiny static server -----------------------------------------------------

const TYPES = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".glb": "model/gltf-binary",
  ".json": "application/json",
};

function serve() {
  const server = createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (url === "/") return send(res, 200, "text/html", PAGE);
    if (url === "/favicon.ico") return send(res, 204, "text/plain", "");
    if (url === "/__harness.js") return send(res, 200, "text/javascript", HARNESS);
    let file = path.join(ROOT, url);
    if (!file.startsWith(ROOT + path.sep)) return send(res, 403, "text/plain", "forbidden");
    // The app's bundler resolves extensionless imports (./grooveGestures).
    if (!existsSync(file) && existsSync(`${file}.js`)) file = `${file}.js`;
    if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, "text/plain", "not found");
    send(res, 200, TYPES[path.extname(file)] || "application/octet-stream", readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

// --- render -----------------------------------------------------------------

const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
const framesDir = mkdtempSync(path.join(os.tmpdir(), "stem-gif-"));

// The full Chromium build in headless mode, on the real GPU through Metal.
const browser = await chromium.launch({
  channel: "chromium",
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage({
    viewport: { width: VIEW, height: VIEW },
    deviceScaleFactor: SUPERSAMPLE,
  });
  page.on("pageerror", (err) => console.error("[page]", err));
  page.on("console", (msg) => msg.type() === "error" && console.error("[page]", msg.text()));
  await page.addInitScript((config) => (window.__config = config), { FPS, FRAMES, SEED, stemColors });
  await page.goto(origin);
  await page.waitForFunction(() => window.__ready, null, { timeout: 30000 });

  for (let f = -WARMUP; f < 0; f++) await page.evaluate((n) => window.__step(n), f);
  for (let f = 0; f < FRAMES; f++) {
    await page.evaluate((n) => window.__step(n), f);
    await page.screenshot({
      path: path.join(framesDir, `${String(f).padStart(4, "0")}.png`),
      clip: { x: (VIEW - SIZE) / 2, y: (VIEW - SIZE) / 2, width: SIZE, height: SIZE },
    });
    if (f % 25 === 0) process.stdout.write(`\rframe ${f + 1}/${FRAMES}`);
  }
  process.stdout.write(`\rframe ${FRAMES}/${FRAMES}\n`);

  const stats = await page.evaluate(() => window.__stats());
  console.log(`gpu: ${stats.gpu}`);
  console.log(`pose error: ${stats.maxPoseErrorDeg.toFixed(4)} deg max`);
  console.log(`loop: lands ${stats.endErrorDeg.toFixed(4)} deg from home, spin ${stats.endSpeed.toFixed(5)} rad/s`);
  const reach = (stats.maxExtent * VIEW) / SIZE;
  console.log(`framing: device reaches ${(reach * 100).toFixed(1)}% of the half-frame at most`);
  if (reach > 0.985) throw new Error("the device leaves the frame at some pose");
} finally {
  await browser.close();
  server.close();
}

// --- encode -----------------------------------------------------------------

mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync(
  FFMPEG,
  [
    "-v", "error", "-y",
    "-framerate", String(FPS),
    "-i", path.join(framesDir, "%04d.png"),
    "-filter_complex",
    [
      `scale=${SIZE}:${SIZE}:flags=lanczos,split[a][b]`,
      "[a]palettegen=max_colors=256:stats_mode=diff:reserve_transparent=0[p]",
      "[b][p]paletteuse=dither=sierra3:diff_mode=rectangle",
    ].join(";"),
    "-loop", "0",
    OUT,
  ],
  { stdio: "inherit" }
);

if (KEEP_FRAMES) console.log(`frames kept in ${framesDir}`);
else rmSync(framesDir, { recursive: true, force: true });
const kb = statSync(OUT).size / 1024;
console.log(
  `${path.relative(ROOT, OUT)}  ${SIZE}x${SIZE}  ${FPS} fps  ${FRAMES} frames  ${(kb / 1024).toFixed(2)} MB`
);
