import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_FEEDBACK_URL,
  CLIENT_KEY,
  MAX_PREFILL_URL,
  feedbackUrl,
  describePython,
  collectSystemInfo,
  buildReport,
  reportText,
  buildPrefillUrl,
  friendlyError,
  submitReport,
} = require("../electron/feedback/report.js");
const { validateReport } = require("../electron/feedback/issue.js");
const { DEFAULT_CLIENT_KEY } = require("../feedback-relay/lib/relay.js");

const ENGINE = "/Users/someone/Library/Application Support/Stem Player/stem-engine/python/bin/python3.13";
const FIELDS = { title: "Vocals drop out", description: "Silent after a minute.", steps: "1. Play", includeSystem: true, website: "" };
const SYSTEM = collectSystemInfo({
  appVersion: "0.1.0",
  macos: "15.1.0",
  chip: "Apple M2 Pro",
  memoryBytes: 16 * 2 ** 30,
  engine: ENGINE,
  python: ENGINE,
});

test("the app and the relay agree on the client key", () => {
  assert.equal(CLIENT_KEY, DEFAULT_CLIENT_KEY);
});

test("the relay URL is a constant that STEM_PLAYER_FEEDBACK_URL overrides", () => {
  assert.equal(feedbackUrl({}), DEFAULT_FEEDBACK_URL);
  assert.equal(feedbackUrl({ STEM_PLAYER_FEEDBACK_URL: "http://127.0.0.1:9/api/feedback" }), "http://127.0.0.1:9/api/feedback");
});

test("Python is described by where it came from, never by a user's path", () => {
  assert.equal(describePython({ python: ENGINE, engine: ENGINE }), "stem engine");
  assert.equal(describePython({ python: "/Users/me/venv/bin/python", override: "/Users/me/venv/bin/python" }), "custom (STEM_PLAYER_PYTHON)");
  assert.equal(describePython({ python: "/opt/homebrew/bin/python3" }), "/opt/homebrew/bin/python3");
  assert.equal(describePython({ python: "python3" }), "python3");
  assert.equal(describePython({ python: "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3" }), "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3");
  assert.equal(describePython({ python: "/Users/me/miniconda3/bin/python3" }), "other");
  assert.equal(describePython({ python: null }), "none found");
  assert.equal(describePython({}), "unknown");
});

test("system info says what the spec lists and holds no paths", () => {
  assert.deepEqual(SYSTEM, {
    app: "0.1.0",
    macos: "15.1.0",
    chip: "Apple M2 Pro",
    memory: "16 GB",
    engine: "installed",
    python: "stem engine",
  });
  assert.ok(!JSON.stringify(SYSTEM).includes("/Users"));
  const bare = collectSystemInfo({ appVersion: "0.1.0", macos: "14.0.0", chip: "", memoryBytes: 8 * 2 ** 30, engine: null, python: null });
  assert.equal(bare.engine, "not installed");
  assert.equal(bare.python, "none found");
  assert.equal(bare.chip, "unknown");
  const timedOut = collectSystemInfo({ appVersion: "0.1.0", macos: "14.0.0", chip: "Apple M1", memoryBytes: 8 * 2 ** 30 });
  assert.equal(timedOut.engine, "unknown");
  assert.equal(timedOut.python, "unknown");
  // Whatever it says passes the relay's validation.
  assert.equal(validateReport(buildReport("bug", FIELDS, bare)).ok, true);
});

test("a report carries system info only when the box is ticked, and steps only for bugs", () => {
  const withInfo = buildReport("bug", FIELDS, SYSTEM);
  assert.deepEqual(withInfo, { type: "bug", title: FIELDS.title, description: FIELDS.description, steps: "1. Play", system: SYSTEM, website: "" });
  assert.equal(validateReport(withInfo).ok, true);
  assert.equal(buildReport("bug", { ...FIELDS, includeSystem: false }, SYSTEM).system, undefined);
  const feature = buildReport("feature", FIELDS, SYSTEM);
  assert.equal(feature.steps, undefined);
  assert.equal(validateReport(feature).ok, true);
});

test("the copied report is the title and the issue body", () => {
  const text = reportText(buildReport("bug", FIELDS, SYSTEM));
  assert.ok(text.startsWith("Vocals drop out\n\n### Description\n\nSilent after a minute.\n\n### Steps to reproduce\n\n1. Play\n"));
  assert.ok(text.includes("<summary>System info</summary>"));
  assert.ok(text.includes("- Chip: Apple M2 Pro"));
  // A half-filled draft still previews.
  assert.ok(reportText(buildReport("bug", { title: "", description: "" }, null)).includes("### Description"));
});

test("the GitHub link opens the matching template with its fields filled in", () => {
  const { url, truncated } = buildPrefillUrl(buildReport("bug", FIELDS, SYSTEM));
  assert.equal(truncated, false);
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://github.com/PravdeepK/stem-player/issues/new");
  assert.equal(parsed.searchParams.get("template"), "bug.yml");
  assert.equal(parsed.searchParams.get("title"), "Vocals drop out");
  assert.equal(parsed.searchParams.get("description"), "Silent after a minute.");
  assert.equal(parsed.searchParams.get("steps"), "1. Play");
  assert.equal(parsed.searchParams.get("system").split("\n")[0], "App version: 0.1.0");
  assert.ok(!url.includes("+"), "spaces are %20, not +");

  const feature = new URL(buildPrefillUrl(buildReport("feature", { ...FIELDS, includeSystem: false }, SYSTEM)).url);
  assert.equal(feature.searchParams.get("template"), "feature.yml");
  assert.equal(feature.searchParams.get("steps"), null);
  assert.equal(feature.searchParams.get("system"), null);
});

test("the GitHub link only fills fields the issue templates have", async () => {
  const fs = await import("node:fs");
  for (const [type, file, labels] of [["bug", "bug.yml", "bug"], ["feature", "feature.yml", "enhancement"]]) {
    const yml = fs.readFileSync(new URL(`../.github/ISSUE_TEMPLATE/${file}`, import.meta.url), "utf8");
    const ids = new Set([...yml.matchAll(/^\s+id: (\w+)$/gm)].map((m) => m[1]));
    assert.match(yml, new RegExp(`^labels: \\["${labels}"\\]$`, "m"));
    const params = new URL(buildPrefillUrl(buildReport(type, FIELDS, SYSTEM)).url).searchParams;
    assert.equal(params.get("template"), file);
    for (const key of params.keys()) {
      if (key !== "template" && key !== "title") assert.ok(ids.has(key), `${file} has no field "${key}"`);
    }
  }
});

test("a report too long for a link is cut to fit, longest field first", () => {
  const long = buildReport("bug", { ...FIELDS, description: "word ".repeat(1000).trim(), steps: "ünïcødé ".repeat(375).trim() }, SYSTEM);
  const { url, truncated } = buildPrefillUrl(long);
  assert.equal(truncated, true);
  assert.ok(url.length <= MAX_PREFILL_URL, `${url.length}`);
  assert.ok(url.length > MAX_PREFILL_URL - 200, "uses most of the room it has");
  const params = new URL(url).searchParams;
  assert.match(params.get("steps"), /Cut short to fit in a link/);
  assert.equal(params.get("title"), FIELDS.title);
  assert.ok(params.get("system"));

  const tight = buildPrefillUrl(long, 1500);
  assert.ok(tight.url.length <= 1500, `${tight.url.length}`);
  assert.match(new URL(tight.url).searchParams.get("description"), /Cut short/);
});

test("cutting a link never splits an emoji", () => {
  const emoji = buildReport("feature", { title: "Emoji", description: "🎵".repeat(3000) }, null);
  const { url } = buildPrefillUrl(emoji, 2000);
  assert.ok(url.length <= 2000);
  assert.doesNotThrow(() => decodeURIComponent(url));
});

test("failures read as plain sentences", () => {
  assert.match(friendlyError("offline"), /Couldn't reach/);
  assert.match(friendlyError("rate_limited", { retryAfter: 61 }), /Try again in 2 minutes/);
  assert.match(friendlyError("rate_limited", { retryAfter: 30 }), /Try again in 1 minute\./);
  assert.match(friendlyError("invalid_field", { message: "title is required." }), /turned down: title is required/);
  assert.match(friendlyError("mystery", { status: 503 }), /HTTP 503/);
});

function stubFetch(status, body, headers = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { fetch, calls };
}

test("submitting posts JSON with the client key and returns the new issue", async () => {
  const { fetch, calls } = stubFetch(201, { ok: true, number: 7, url: "https://github.com/PravdeepK/stem-player/issues/7" });
  const report = buildReport("bug", FIELDS, SYSTEM);
  const result = await submitReport(report, { url: "http://relay.test/api/feedback", fetch, appVersion: "0.1.0" });
  assert.deepEqual(result, { ok: true, number: 7, url: "https://github.com/PravdeepK/stem-player/issues/7" });
  assert.equal(calls[0].url, "http://relay.test/api/feedback");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(calls[0].init.headers["X-Stem-Player-Key"], CLIENT_KEY);
  assert.deepEqual(JSON.parse(calls[0].init.body), report);
});

test("submitting maps every failure to a code and a message, and never throws", async () => {
  const cases = [
    [async () => { throw new TypeError("fetch failed"); }, "offline"],
    [async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }, "timeout"],
    [stubFetch(429, { ok: false, error: "rate_limited", retryAfter: 300 }).fetch, "rate_limited"],
    [stubFetch(400, { ok: false, error: "invalid_field", field: "title", message: "title is required." }).fetch, "invalid_field"],
    [stubFetch(502, { ok: false, error: "github_error" }).fetch, "github_error"],
    [stubFetch(404, "<html>Not found</html>").fetch, "offline"],
    [stubFetch(500, "oops").fetch, "unexpected"],
    // Success that doesn't point at this repo isn't trusted.
    [stubFetch(201, { ok: true, number: 1, url: "https://evil.example/issues/1" }).fetch, "unexpected"],
    [stubFetch(200, { ok: true }).fetch, "unexpected"],
  ];
  for (const [fetch, code] of cases) {
    const result = await submitReport(buildReport("bug", FIELDS, SYSTEM), { url: "http://relay.test", fetch });
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code);
    assert.equal(typeof result.message, "string");
  }
  const limited = await submitReport({}, { url: "x", fetch: stubFetch(429, { ok: false, error: "rate_limited", retryAfter: 300 }).fetch });
  assert.match(limited.message, /5 minutes/);
});

test("a slow relay times out", async () => {
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  // AbortSignal.timeout doesn't hold the process open by itself.
  const keepAlive = setTimeout(() => {}, 1000);
  const result = await submitReport({}, { url: "x", fetch: hang, timeoutMs: 20 });
  clearTimeout(keepAlive);
  assert.equal(result.code, "timeout");
});
