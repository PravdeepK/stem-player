import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { notesFor } from "../scripts/release-notes.mjs";

const CHANGELOG = `# What's new

Intro.

## 0.2.0

- New thing.

## 0.1.10

- Ten.

## 0.1.1

- One.
- **Bold** too.
`;

test("a version's notes stop at the next version", () => {
  assert.equal(notesFor(CHANGELOG, "0.2.0"), "- New thing.");
  assert.equal(notesFor(CHANGELOG, "0.1.1"), "- One.\n- **Bold** too.");
});

test("a version only matches its own heading, not a longer one", () => {
  assert.equal(notesFor(CHANGELOG, "0.1.10"), "- Ten.");
  assert.equal(notesFor("## 0.1.10\n\n- Ten.\n", "0.1.1"), null);
});

test("a missing or empty section has no notes", () => {
  assert.equal(notesFor(CHANGELOG, "9.9.9"), null);
  assert.equal(notesFor("## 0.3.0\n\n## 0.2.0\n- x\n", "0.3.0"), null);
});

test("the current version has notes, so the next release can go out", () => {
  const { version } = createRequire(import.meta.url)("../package.json");
  assert.ok(notesFor(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), version));
});

test("the script prints notes for a tag and refuses one without them", () => {
  const script = new URL("../scripts/release-notes.mjs", import.meta.url).pathname;
  assert.match(execFileSync("node", [script, "v0.1.1"], { encoding: "utf8" }), /stem engine/);
  const missing = spawnSync("node", [script, "v9.9.9"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /## 9\.9\.9/);
});
