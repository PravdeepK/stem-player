import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";

const {
  createStemEngine,
  createUvProgress,
  verifySha256,
  dirSize,
  formatSize,
  supportsMacOS,
  VERSIONS,
} = createRequire(import.meta.url)("../electron/stemEngine.js");

const UV_BYTES = Buffer.from("pretend uv tarball");
const UV_SHA = crypto.createHash("sha256").update(UV_BYTES).digest("hex");
const PY_DIR = `cpython-${VERSIONS.python}-macos-aarch64-none`;

// A stand-in for child_process.spawn that plays tar, uv and the engine's Python.
// `failAt` makes one step exit 1; `hangAt` makes one wait until it is killed.
function fakeSpawn({ failAt, hangAt, calls = [] } = {}) {
  return (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const step = cmd === "/usr/bin/tar" ? "tar" : args[0] === "python" ? "python" : args[0] === "pip" ? "pip" : "verify";
    calls.push({ step, cmd, args, env: opts.env });
    const finish = (code) => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", code));
    };
    child.kill = () => finish(null);
    setImmediate(() => {
      if (step === hangAt) return;
      if (step === failAt) {
        child.stderr.write("error: something broke\n");
        return finish(1);
      }
      if (step === "tar") {
        fs.writeFileSync(path.join(args[args.indexOf("-C") + 1], "uv"), "");
      } else if (step === "python") {
        const pyDir = path.join(opts.env.UV_PYTHON_INSTALL_DIR, PY_DIR);
        fs.mkdirSync(path.join(pyDir, "bin"), { recursive: true });
        fs.writeFileSync(path.join(pyDir, "bin", "python3.13"), "");
        fs.symlinkSync(pyDir, path.join(opts.env.UV_PYTHON_INSTALL_DIR, "cpython-3.13-macos-aarch64-none"));
        fs.writeFileSync(path.join(opts.env.UV_CACHE_DIR, "python.tar.gz"), "x");
      } else if (step === "pip") {
        child.stderr.write("Downloading torch (106.1MiB)\n Downloaded torch\n");
      } else {
        child.stdout.write(JSON.stringify({ torch: VERSIONS.torch, demucs: VERSIONS.demucs, mps: true }) + "\n");
      }
      finish(0);
    });
    return child;
  };
}

function setup({ bytes = UV_BYTES, freeBytes = 1e12, spawn = fakeSpawn() } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "stem-engine-test-"));
  const root = path.join(userData, "stem-engine");
  const fetches = [];
  const engine = createStemEngine(root, {
    spawn,
    fetch: async (url) => {
      fetches.push(url);
      return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    },
    statfs: async () => ({ bavail: freeBytes / 4096, bsize: 4096 }),
    uv: { url: "https://example.invalid/uv.tar.gz", sha256: UV_SHA },
  });
  return {
    userData,
    root,
    engine,
    fetches,
    left: () => fs.readdirSync(userData).sort(),
    done: () => fs.rmSync(userData, { recursive: true, force: true }),
  };
}

test("an install lands in place with only the Python and a manifest", async () => {
  const calls = [];
  const { root, engine, left, done } = setup({ spawn: fakeSpawn({ calls }) });
  const seen = [];
  const python = await engine.install({ onProgress: (v) => seen.push(v) });

  assert.equal(python, path.join(root, "python", PY_DIR, "bin", "python3.13"));
  assert.equal(engine.python(), python);
  assert.deepEqual(left(), ["stem-engine"]);
  assert.deepEqual(fs.readdirSync(root).sort(), ["engine.json", "python"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "python")), [PY_DIR]);
  const manifest = engine.manifest();
  assert.equal(manifest.torch, VERSIONS.torch);
  assert.equal(manifest.demucs, VERSIONS.demucs);
  assert.equal(manifest.pythonVersion, VERSIONS.python);
  assert.equal(seen.at(-1), 1);
  assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]), "progress never goes backwards");

  // uv's caches and Python stay inside the staging folder, ignoring the user's config.
  const pip = calls.find((c) => c.step === "pip");
  assert.ok(pip.env.UV_CACHE_DIR.startsWith(`${root}.partial`));
  assert.ok(pip.env.UV_PYTHON_INSTALL_DIR.startsWith(`${root}.partial`));
  assert.equal(pip.env.UV_NO_CONFIG, "1");
  assert.ok(pip.args.includes("--only-binary"));
  assert.ok(calls.find((c) => c.step === "python").args.includes("--no-bin"));
  assert.equal(calls.find((c) => c.step === "verify").env.PYTHONNOUSERSITE, "1");
  done();
});

test("a uv download that fails its checksum is never run", async () => {
  const calls = [];
  const { engine, left, done } = setup({ bytes: Buffer.from("tampered"), spawn: fakeSpawn({ calls }) });
  await assert.rejects(engine.install(), { code: "ENGINE_CHECKSUM" });
  assert.equal(calls.length, 0);
  assert.deepEqual(left(), []);
  assert.equal(engine.python(), null);
  done();
});

test("a failed step leaves no engine and no staging folder", async () => {
  const { engine, left, done } = setup({ spawn: fakeSpawn({ failAt: "pip" }) });
  await assert.rejects(engine.install(), (err) => err.code === "ENGINE_STEP" && /something broke/.test(err.message));
  assert.deepEqual(left(), []);
  assert.equal(engine.python(), null);
  done();
});

test("cancelling kills the running step and cleans up", async () => {
  const abort = new AbortController();
  const inner = fakeSpawn({ hangAt: "pip" });
  let killed = false;
  const spawn = (cmd, args, opts) => {
    const child = inner(cmd, args, opts);
    if (args[0] === "pip") {
      const kill = child.kill;
      child.kill = () => {
        killed = true;
        kill();
      };
      setImmediate(() => abort.abort());
    }
    return child;
  };
  const { engine, left, done } = setup({ spawn });
  await assert.rejects(engine.install({ signal: abort.signal }), { code: "ENGINE_CANCELLED" });
  assert.equal(killed, true);
  assert.deepEqual(left(), []);
  done();
});

test("too little free space stops before downloading anything", async () => {
  const { engine, fetches, left, done } = setup({ freeBytes: 500e6 });
  await assert.rejects(engine.install(), { code: "ENGINE_NO_SPACE" });
  assert.equal(fetches.length, 0);
  assert.deepEqual(left(), []);
  done();
});

test("a broken install with a manifest that doesn't check out is not an engine", () => {
  const { root, engine, done } = setup();
  assert.equal(engine.python(), null);
  fs.mkdirSync(path.join(root, "python", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "python", "bin", "python3.13"), "");
  const write = (manifest) => fs.writeFileSync(path.join(root, "engine.json"), JSON.stringify(manifest));

  write({ format: 1, python: "python/bin/missing" });
  assert.equal(engine.python(), null);
  write({ format: 99, python: "python/bin/python3.13" });
  assert.equal(engine.python(), null);
  write({ format: 1, python: "../../../../usr/bin/true" });
  assert.equal(engine.python(), null);
  fs.writeFileSync(path.join(root, "engine.json"), "{ not json");
  assert.equal(engine.python(), null);
  write({ format: 1, python: "python/bin/python3.13" });
  assert.equal(engine.python(), path.join(root, "python", "bin", "python3.13"));
  done();
});

test("the engine's Python sees only its own packages and keeps weights inside it", () => {
  const { root, engine, done } = setup();
  const env = engine.env({
    PATH: "/usr/bin",
    HF_TOKEN: "t",
    PYTHONPATH: "/somewhere",
    PYTHONHOME: "/elsewhere",
    UV_INDEX_URL: "https://mirror.invalid",
    VIRTUAL_ENV: "/venv",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HF_TOKEN, "t");
  assert.equal(env.PYTHONNOUSERSITE, "1");
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.UV_INDEX_URL, undefined);
  assert.equal(env.VIRTUAL_ENV, undefined);
  for (const key of ["HF_HOME", "TORCH_HOME"]) assert.ok(env[key].startsWith(root + path.sep), key);
  done();
});

test("removing deletes everything, weights included, and is safe to repeat", async () => {
  const { root, engine, left, done } = setup();
  await engine.install();
  fs.mkdirSync(path.join(root, "models", "huggingface"), { recursive: true });
  fs.writeFileSync(path.join(root, "models", "huggingface", "weights.th"), Buffer.alloc(1000));
  assert.ok((await engine.size()) >= 1000);
  const removal = engine.remove();
  assert.equal(engine.python(), null, "unusable as soon as removal starts");
  await removal;
  assert.deepEqual(left(), []);
  await engine.remove();
  done();
});

test("leftovers from an interrupted install or removal are cleared", async () => {
  const { root, engine, left, done } = setup();
  fs.mkdirSync(`${root}.partial/python`, { recursive: true });
  fs.mkdirSync(`${root}.removing`, { recursive: true });
  await engine.clearLeftovers();
  assert.deepEqual(left(), []);
  done();
});

test("sha256 verification accepts the right file and rejects the wrong one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stem-engine-sha-"));
  const file = path.join(dir, "f");
  fs.writeFileSync(file, UV_BYTES);
  await verifySha256(file, UV_SHA);
  await verifySha256(file, UV_SHA.toUpperCase());
  await assert.rejects(verifySha256(file, "0".repeat(64)), { code: "ENGINE_CHECKSUM" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("uv's download lines and unpacked bytes become a fraction", () => {
  const p = createUvProgress(1000);
  assert.equal(p.fraction(), 0);
  p.line("Downloading torch (90.0MiB)");
  p.line("Downloading sympy (10.0MiB)");
  p.line(" Downloaded sympy");
  assert.ok(Math.abs(p.fraction() - 0.1) < 1e-9);
  p.unpacked(500);
  assert.equal(p.fraction(), 0.5);
  p.line(" Downloaded torch");
  assert.equal(p.fraction(), 1);
});

test("folder sizes, size labels and the macOS floor", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stem-engine-size-"));
  fs.mkdirSync(path.join(dir, "a"));
  fs.writeFileSync(path.join(dir, "a", "x"), Buffer.alloc(300));
  fs.writeFileSync(path.join(dir, "y"), Buffer.alloc(200));
  fs.symlinkSync("/usr/bin", path.join(dir, "link"));
  assert.equal(await dirSize(dir), 500);
  assert.equal(await dirSize(path.join(dir, "missing")), 0);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(formatSize(747927399), "748 MB");
  assert.equal(formatSize(1.25e9), "1.3 GB");
  assert.equal(supportsMacOS("13.6.1"), false);
  assert.equal(supportsMacOS("14.0"), true);
  assert.equal(supportsMacOS("27.0.1"), true);
});
