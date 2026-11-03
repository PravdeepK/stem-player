import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const { createStemCache } = createRequire(import.meta.url)("../electron/stemCache.js");
const STEMS = ["vocals", "drums", "bass", "instrumental"];
const idOf = (c) => `${c.repeat(32)}-htdemucs`;
const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(maxBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stem-cache-test-"));
  const cache = createStemCache(dir, maxBytes);
  const add = (id, title, bytes = 500) => {
    const stemsDir = cache.begin(id);
    for (const s of STEMS) fs.writeFileSync(path.join(stemsDir, `${s}.wav`), Buffer.alloc(bytes));
    return cache.commit(id, title, "htdemucs");
  };
  return { dir, cache, add, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a committed entry is listed with its stems", () => {
  const { cache, add, done } = setup(1e9);
  const entry = add(idOf("a"), "one");
  assert.equal(entry.title, "one");
  assert.deepEqual(Object.keys(entry.stems).sort(), [...STEMS].sort());
  assert.equal(cache.list().length, 1);
  done();
});

test("the oldest entries go first once over the limit, never the kept one", async () => {
  const { cache, add, done } = setup(3000);
  add(idOf("a"), "one");
  await tick();
  add(idOf("b"), "two");
  cache.prune(idOf("b"));
  assert.deepEqual(cache.list().map((e) => e.title), ["two"]);
  done();
});

test("touching an entry makes it the newest", async () => {
  const { cache, add, done } = setup(1e9);
  add(idOf("a"), "one");
  await tick();
  add(idOf("b"), "two");
  await tick();
  cache.touch(idOf("a"));
  assert.deepEqual(cache.list().map((e) => e.title), ["one", "two"]);
  done();
});

test("the kept entry survives even on its own over the limit", () => {
  const { cache, add, done } = setup(1);
  add(idOf("a"), "big");
  cache.prune(idOf("a"));
  assert.equal(cache.list().length, 1);
  done();
});

test("an unfinished run is invisible and cleared on startup", () => {
  const { dir, cache, done } = setup(1e9);
  const stemsDir = cache.begin(idOf("c"));
  fs.writeFileSync(path.join(stemsDir, "vocals.wav"), "partial");
  assert.equal(cache.touch(idOf("c")), null);
  assert.equal(cache.list().length, 0);
  cache.clearTemp();
  assert.equal(fs.readdirSync(dir).some((f) => f.startsWith(".tmp-")), false);
  done();
});

test("ids that could escape the cache folder are refused", () => {
  const { cache, done } = setup(1e9);
  assert.equal(cache.touch("../../etc"), null);
  assert.equal(cache.touch("aaaa/../../x-htdemucs"), null);
  done();
});

test("ids follow the audio, not the filename, and keep models apart", async () => {
  const { dir, cache, done } = setup(1e9);
  const a = path.join(dir, "song.mp3");
  const b = path.join(dir, "renamed copy.mp3");
  fs.writeFileSync(a, "same bytes");
  fs.writeFileSync(b, "same bytes");
  assert.equal(await cache.idFor(a, "htdemucs"), await cache.idFor(b, "htdemucs"));
  assert.notEqual(await cache.idFor(a, "htdemucs"), await cache.idFor(a, "htdemucs_ft"));
  done();
});
