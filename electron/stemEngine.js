"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const childProcess = require("child_process");

// The stem engine: a private Python with PyTorch and Demucs, downloaded the
// first time someone makes stems on a Mac that has no Python of its own.
//
//   <root>/engine.json                       { format, python, torch, ..., installedAt }
//   <root>/python/cpython-<ver>-.../bin/...  a uv-managed standalone Python
//   <root>/models/                           model weights, fetched on first use
//
// It is built in <root>.partial by a pinned uv release and renamed into place
// only once it has imported torch and demucs, so a failed or cancelled install
// never looks like an engine. Removing renames it to <root>.removing first.

const FORMAT = 1;
const UV_VERSION = "0.12.24";
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`;
// The release's published uv-aarch64-apple-darwin.tar.gz.sha256.
const UV_SHA256 = "0c4346de7abdb49495b393b9ec809fe387aa43e586be20fecb972216c1e71732";
const PYTHON_VERSION = "3.13.16";
const TORCH_VERSION = "2.13.0";
const DEMUCS_VERSION = "4.1.0";

// The whole tree, pinned to the set Demucs is known to work with here. numpy is
// listed by hand: demucs imports it but only declares it for Intel Macs.
const REQUIREMENTS = [
  `torch==${TORCH_VERSION}`,
  `demucs==${DEMUCS_VERSION}`,
  "numpy==2.4.1",
  "anyio==4.14.2",
  "certifi==2026.7.22",
  "click==8.5.0",
  "einops==0.8.2",
  "filelock==3.32.4",
  "fsspec==2026.7.0",
  "h11==0.16.0",
  "hf-xet==1.6.0",
  "httpcore==1.0.9",
  "httpx==0.28.1",
  "huggingface-hub==1.29.0",
  "idna==3.19",
  "jinja2==3.1.6",
  "julius==0.2.8",
  "lameenc==1.8.4",
  "markupsafe==3.0.3",
  "mpmath==1.3.0",
  "networkx==3.6.1",
  "packaging==26.3",
  "pyyaml==6.0.3",
  "safetensors==0.8.0",
  "setuptools==84.0.0",
  "sphn==0.2.1",
  "sympy==1.14.0",
  "tqdm==4.70.0",
  "typing-extensions==4.16.0",
];

// Measured on an M4: about 180 MB to download (uv 15, Python 25, wheels 140)
// and 750 MB installed, before any model weights. uv unpacks every wheel into
// its cache first, so the build briefly needs about twice that.
const DOWNLOAD_BYTES = 180e6;
const INSTALLED_BYTES = 750e6;
const UNPACKED_BYTES = 730e6;
const NEEDED_BYTES = 2e9;
// PyTorch 2.13 publishes Apple silicon wheels for macOS 14 and later only.
const MIN_MACOS = 14;

const VERIFY_SCRIPT =
  "import json, torch, demucs, demucs.api; " +
  "print(json.dumps({'torch': torch.__version__, 'demucs': demucs.__version__, " +
  "'mps': torch.backends.mps.is_available()}))";

function engineError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** "14.2.1" -> true, "13.6" -> false. */
function supportsMacOS(version) {
  return parseInt(String(version), 10) >= MIN_MACOS;
}

/** 1234567890 -> "1.2 GB". */
function formatSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifySha256(file, expected) {
  const actual = await sha256File(file);
  if (actual !== expected.toLowerCase()) {
    throw engineError("ENGINE_CHECKSUM", `checksum mismatch for ${path.basename(file)}: ${actual}`);
  }
}

/** Total bytes of a folder, without following symlinks. */
async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += await fs.promises.lstat(full).then((s) => s.size, () => 0);
  }
  return total;
}

function parseSize(text) {
  const m = /^([\d.]+)\s*(B|KiB|MiB|GiB)$/.exec(text.trim());
  if (!m) return 0;
  return parseFloat(m[1]) * { B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30 }[m[2]];
}

/**
 * Follows `uv pip install` to a 0-1 fraction. uv names each large wheel as it
 * starts ("Downloading torch (106.1MiB)") and finishes (" Downloaded torch"),
 * but says nothing in between, so the bytes it has unpacked into its cache
 * fill the gap while torch, most of the download, comes in.
 */
function createUvProgress(expectedBytes = UNPACKED_BYTES) {
  const sizes = new Map();
  const done = new Set();
  let unpacked = 0;
  return {
    unpacked(bytes) {
      unpacked = bytes;
    },
    line(text) {
      let m = /^\s*Downloading (\S+) \(([^)]+)\)/.exec(text);
      if (m) sizes.set(m[1], parseSize(m[2]));
      m = /^\s*Downloaded (\S+)/.exec(text);
      if (m) done.add(m[1]);
    },
    fraction() {
      let total = 0;
      let got = 0;
      for (const [name, size] of sizes) {
        total += size;
        if (done.has(name)) got += size;
      }
      return Math.max(total > 0 ? got / total : 0, Math.min(0.95, unpacked / expectedBytes));
    },
  };
}

/** The engine's settings for uv and Python, free of the user's own. */
function cleanEnv(base) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^(UV_|PYTHON|PIP_|VIRTUAL_ENV$|CONDA_)/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function createStemEngine(root, options = {}) {
  const spawn = options.spawn || childProcess.spawn;
  const fetch = options.fetch || globalThis.fetch;
  const statfs = options.statfs || ((dir) => fs.promises.statfs(dir));
  const uv = { url: UV_URL, sha256: UV_SHA256, ...options.uv };

  const staging = `${root}.partial`;
  const removing = `${root}.removing`;
  const manifestPath = path.join(root, "engine.json");

  function readManifest() {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      return manifest && manifest.format === FORMAT ? manifest : null;
    } catch {
      return null;
    }
  }

  /** The engine's Python, or null when it isn't (completely) installed. */
  function python() {
    const manifest = readManifest();
    if (!manifest || typeof manifest.python !== "string") return null;
    const file = path.resolve(root, manifest.python);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return null;
    return file;
  }

  /** Environment for running the engine's Python: only its own packages, weights inside it. */
  function env(base = process.env) {
    return {
      ...cleanEnv(base),
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      HF_HOME: path.join(root, "models", "huggingface"),
      HF_HUB_DISABLE_TELEMETRY: "1",
      TORCH_HOME: path.join(root, "models", "torch"),
    };
  }

  /** Run a command, passing each stderr/stdout line on. Resolves to stdout. */
  function run(cmd, args, { env: runEnv, signal, onLine }) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(engineError("ENGINE_CANCELLED", "cancelled"));
        return;
      }
      let child;
      try {
        child = spawn(cmd, args, { env: runEnv });
      } catch (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      let pending = "";
      const kill = () => child.kill();
      if (signal) signal.addEventListener("abort", kill, { once: true });
      const feed = (chunk) => {
        pending += chunk;
        let idx;
        while ((idx = pending.indexOf("\n")) !== -1) {
          if (onLine) onLine(pending.slice(0, idx));
          pending = pending.slice(idx + 1);
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        feed(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (signal) signal.removeEventListener("abort", kill);
        if (signal && signal.aborted) reject(engineError("ENGINE_CANCELLED", "cancelled"));
        else if (code === 0) resolve(stdout);
        else reject(engineError("ENGINE_STEP", `${path.basename(cmd)} ${args[0]} exited with ${code}:\n${stderr.trim()}`));
      });
    });
  }

  async function download(url, file, { signal, onBytes }) {
    const res = await fetch(url, { signal, redirect: "follow" });
    if (!res.ok || !res.body) throw engineError("ENGINE_DOWNLOAD", `download failed (${res.status}): ${url}`);
    const total = Number(res.headers.get("content-length")) || 0;
    let got = 0;
    const body = Readable.fromWeb(res.body);
    body.on("data", (chunk) => {
      got += chunk.length;
      if (total && onBytes) onBytes(got / total);
    });
    await pipeline(body, fs.createWriteStream(file), { signal });
  }

  async function clearLeftovers() {
    await fs.promises.rm(staging, { recursive: true, force: true });
    await fs.promises.rm(removing, { recursive: true, force: true });
  }

  /**
   * Download and build the engine. Resolves to its Python path; rejects with an
   * error whose code is ENGINE_NO_SPACE, ENGINE_CANCELLED, ENGINE_CHECKSUM,
   * ENGINE_DOWNLOAD or ENGINE_STEP, leaving nothing behind but what was there.
   */
  async function install({ onProgress = () => {}, signal } = {}) {
    let shown = 0;
    const report = (value) => {
      shown = Math.max(shown, Math.min(1, value));
      onProgress(shown);
    };
    const parent = path.dirname(root);
    await fs.promises.mkdir(parent, { recursive: true });
    await clearLeftovers();

    const stats = await statfs(parent);
    if (stats.bavail * stats.bsize < NEEDED_BYTES) {
      throw engineError("ENGINE_NO_SPACE", `needs ${formatSize(NEEDED_BYTES)} free`);
    }

    const dirs = {
      download: path.join(staging, "download"),
      uv: path.join(staging, "uv"),
      cache: path.join(staging, "cache"),
      python: path.join(staging, "python"),
    };
    try {
      for (const dir of Object.values(dirs)) await fs.promises.mkdir(dir, { recursive: true });
      report(0);

      // 1. uv itself, checked against the release's published sha256.
      const tarball = path.join(dirs.download, "uv.tar.gz");
      await download(uv.url, tarball, { signal, onBytes: (f) => report(f * 0.05) });
      await verifySha256(tarball, uv.sha256);
      await run("/usr/bin/tar", ["-xzf", tarball, "-C", dirs.uv, "--strip-components", "1"], { env: process.env, signal });
      const uvBin = path.join(dirs.uv, "uv");

      const uvEnv = {
        ...cleanEnv(process.env),
        UV_NO_CONFIG: "1",
        UV_CACHE_DIR: dirs.cache,
        UV_PYTHON_INSTALL_DIR: dirs.python,
        UV_PYTHON_BIN_DIR: path.join(staging, "bin"),
        UV_NO_PROGRESS: "1",
      };

      // 2. A standalone Python, kept inside the engine (no links in ~/.local/bin).
      report(0.05);
      await run(uvBin, ["python", "install", PYTHON_VERSION, "--no-bin"], { env: uvEnv, signal });
      const pyDir = (await fs.promises.readdir(dirs.python, { withFileTypes: true })).find(
        (e) => e.isDirectory() && e.name.startsWith(`cpython-${PYTHON_VERSION}-`)
      );
      if (!pyDir) throw engineError("ENGINE_STEP", "uv installed no Python");
      const pyRel = path.join("python", pyDir.name, "bin", `python${PYTHON_VERSION.split(".").slice(0, 2).join(".")}`);
      const stagedPython = path.join(staging, pyRel);

      // 3. PyTorch and Demucs, wheels only so nothing needs a compiler.
      report(0.15);
      const reqFile = path.join(dirs.download, "requirements.txt");
      await fs.promises.writeFile(reqFile, REQUIREMENTS.join("\n") + "\n");
      const progress = createUvProgress();
      const tick = () => report(0.15 + progress.fraction() * 0.75);
      const baseline = await dirSize(dirs.cache);
      let polling = false;
      const poll = setInterval(async () => {
        if (polling) return;
        polling = true;
        progress.unpacked((await dirSize(dirs.cache)) - baseline);
        polling = false;
        tick();
      }, 1000);
      await run(
        uvBin,
        [
          "pip", "install",
          "--python", stagedPython,
          "--break-system-packages",
          "--only-binary", ":all:",
          "--compile-bytecode",
          "-r", reqFile,
        ],
        {
          env: uvEnv,
          signal,
          onLine: (text) => {
            progress.line(text);
            tick();
          },
        }
      ).finally(() => clearInterval(poll));

      // 4. Prove it imports with nothing from the user's own Python.
      report(0.9);
      const out = await run(stagedPython, ["-c", VERIFY_SCRIPT], { env: env(process.env), signal });
      const found = JSON.parse(out.trim().split("\n").pop());
      if (!String(found.torch).startsWith(TORCH_VERSION) || found.demucs !== DEMUCS_VERSION) {
        throw engineError("ENGINE_STEP", `unexpected versions: ${out.trim()}`);
      }

      // 5. Keep only the Python, then move it into place.
      for (const dir of [dirs.cache, dirs.uv, dirs.download, path.join(staging, "bin")]) {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
      for (const entry of await fs.promises.readdir(dirs.python, { withFileTypes: true })) {
        // uv's minor-version links and lock files point at the staging path.
        if (entry.name !== pyDir.name) {
          await fs.promises.rm(path.join(dirs.python, entry.name), { recursive: true, force: true });
        }
      }
      const manifest = {
        format: FORMAT,
        python: pyRel,
        pythonVersion: PYTHON_VERSION,
        torch: TORCH_VERSION,
        demucs: DEMUCS_VERSION,
        uv: UV_VERSION,
        mps: !!found.mps,
        installedAt: new Date().toISOString(),
      };
      await fs.promises.writeFile(path.join(staging, "engine.json"), JSON.stringify(manifest, null, 2));
      if (signal && signal.aborted) throw engineError("ENGINE_CANCELLED", "cancelled");
      await fs.promises.rm(root, { recursive: true, force: true });
      await fs.promises.rename(staging, root);
      report(1);
      return path.join(root, pyRel);
    } catch (err) {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (signal && signal.aborted) throw engineError("ENGINE_CANCELLED", "cancelled");
      throw err;
    }
  }

  return {
    root,
    python,
    manifest: readManifest,
    env,
    install,
    clearLeftovers,

    /** Bytes the engine takes on disk, model weights included. */
    size: () => dirSize(root),

    /** Delete the engine. It stops being usable the moment this is called. */
    remove() {
      try {
        // Only there if a removal was cut short, and cleared on startup anyway.
        fs.rmSync(removing, { recursive: true, force: true });
        fs.renameSync(root, removing);
      } catch (err) {
        if (err.code !== "ENOENT") return Promise.reject(err);
      }
      return fs.promises.rm(removing, { recursive: true, force: true });
    },
  };
}

module.exports = {
  createStemEngine,
  createUvProgress,
  verifySha256,
  dirSize,
  formatSize,
  supportsMacOS,
  DOWNLOAD_BYTES,
  INSTALLED_BYTES,
  NEEDED_BYTES,
  VERSIONS: { uv: UV_VERSION, python: PYTHON_VERSION, torch: TORCH_VERSION, demucs: DEMUCS_VERSION },
};
