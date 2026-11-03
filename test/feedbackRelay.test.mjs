import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateReport, formatIssueBody, issueLabels, LIMITS } = require("../feedback-relay/lib/issue.js");
const { createGitHubClient, signAppJwt, normalizePem } = require("../feedback-relay/lib/github.js");
const { createRelay, createRateLimiter, nodeHandler, clientIp, DEFAULT_CLIENT_KEY, MAX_BODY_BYTES } = require("../feedback-relay/lib/relay.js");

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const ENV = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_INSTALLATION_ID: "987",
};

const SYSTEM = { app: "0.1.0", macos: "15.1.0", chip: "Apple M2 Pro", memory: "16 GB", engine: "installed", python: "stem engine" };

const goodBug = (extra = {}) => ({
  type: "bug",
  title: "Vocals drop out",
  description: "The vocals stem goes silent after a minute.",
  steps: "1. Open a song\n2. Wait",
  system: SYSTEM,
  website: "",
  ...extra,
});

function decodeJwt(jwt) {
  const [h, p, s] = jwt.split(".");
  const ok = crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
  return { ok, header: JSON.parse(Buffer.from(h, "base64url")), payload: JSON.parse(Buffer.from(p, "base64url")) };
}

// A stand-in for GitHub: records every call and answers like the real API.
function fakeGitHub({ issueStatus = 201, tokenStatus = 201, labels } = {}) {
  const calls = [];
  let next = 41;
  const fetch = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/access_tokens")) {
      if (tokenStatus !== 201) return reply(tokenStatus, { message: "Bad credentials" });
      return reply(201, { token: "ghs_test", expires_at: new Date(Date.now() + 3600e3).toISOString() });
    }
    if (issueStatus !== 201) return reply(issueStatus, { message: "Validation Failed" });
    next++;
    const names = labels || call.body.labels;
    return reply(201, {
      number: next,
      html_url: `https://github.com/PravdeepK/stem-player/issues/${next}`,
      labels: names.map((name) => ({ name })),
    });
  };
  return { fetch, calls };
}

const quiet = { log() {}, warn() {}, error() {} };

function request(body, headers = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-stem-player-key": DEFAULT_CLIENT_KEY, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ip: "203.0.113.7",
  };
}

const parse = (res) => JSON.parse(res.body);

// --- the shared issue module ---------------------------------------------

test("the app's copy of issue.js matches the relay's byte for byte", () => {
  const relay = fs.readFileSync(new URL("../feedback-relay/lib/issue.js", import.meta.url));
  const app = fs.readFileSync(new URL("../electron/feedback/issue.js", import.meta.url));
  assert.ok(relay.equals(app), "copy feedback-relay/lib/issue.js over electron/feedback/issue.js");
});

test("validation accepts a good bug report and trims it", () => {
  const checked = validateReport(goodBug({ title: "  Vocals\ndrop   out  ", description: "Line one\r\nline two  " }));
  assert.equal(checked.ok, true);
  assert.equal(checked.report.title, "Vocals drop out");
  assert.equal(checked.report.description, "Line one\nline two");
  assert.deepEqual(checked.report.system, SYSTEM);
});

test("validation rejects bad types, missing and oversized fields, and unknown keys", () => {
  const cases = [
    [null, "body"],
    [[], "body"],
    [goodBug({ type: "question" }), "type"],
    [goodBug({ type: "constructor" }), "type"],
    [goodBug({ title: undefined }), "title"],
    [goodBug({ title: "  a " }), "title"],
    [goodBug({ title: 42 }), "title"],
    [goodBug({ title: "x".repeat(LIMITS.title.max + 1) }), "title"],
    [goodBug({ description: "" }), "description"],
    [goodBug({ description: "x".repeat(LIMITS.description.max + 1) }), "description"],
    [goodBug({ steps: "x".repeat(LIMITS.steps.max + 1) }), "steps"],
    [goodBug({ type: "feature" }), "steps"],
    [goodBug({ system: "M2" }), "system"],
    [goodBug({ system: { ...SYSTEM, songs: "Secret Song.mp3" } }), "system"],
    [goodBug({ system: { chip: 5 } }), "system"],
    [goodBug({ system: { chip: "x".repeat(LIMITS.systemValue + 1) } }), "system"],
    [goodBug({ logs: "..." }), "logs"],
    [goodBug({ website: 1 }), "website"],
  ];
  for (const [input, field] of cases) {
    const checked = validateReport(input);
    assert.equal(checked.ok, false, JSON.stringify(input));
    assert.equal(checked.field, field, JSON.stringify(input));
  }
});

test("feature requests need no steps or system info", () => {
  const checked = validateReport({ type: "feature", title: "Loop a section", description: "Let me loop the chorus." });
  assert.equal(checked.ok, true);
  assert.equal(checked.report.system, null);
  assert.deepEqual(issueLabels("feature"), ["enhancement", "from-app"]);
  assert.deepEqual(issueLabels("bug"), ["bug", "from-app"]);
});

test("the issue body is clean markdown with a collapsed system info section", () => {
  const { report } = validateReport(goodBug());
  assert.equal(
    formatIssueBody(report),
    [
      "### Description",
      "",
      "The vocals stem goes silent after a minute.",
      "",
      "### Steps to reproduce",
      "",
      "1. Open a song",
      "2. Wait",
      "",
      "<details>",
      "<summary>System info</summary>",
      "",
      "- App version: 0.1.0",
      "- macOS: 15.1.0",
      "- Chip: Apple M2 Pro",
      "- Memory: 16 GB",
      "- Stem engine: installed",
      "- Python: stem engine",
      "",
      "</details>",
      "",
    ].join("\n")
  );
});

test("the issue body escapes HTML and mentions, and leaves out empty sections", () => {
  const { report } = validateReport({
    type: "bug",
    title: "Weird",
    description: "Hey @octocat, </details><img src=x onerror=alert(1)> mail me@example.com",
    system: { chip: "<b>M1</b> `x` @bot" },
  });
  const body = formatIssueBody(report);
  assert.ok(body.includes("Hey `@octocat`, &lt;/details>&lt;img src=x onerror=alert(1)>"));
  assert.ok(body.includes("me@example.com"), "an email isn't a mention");
  assert.ok(!body.includes("Steps to reproduce"));
  assert.ok(body.includes("- Chip: bM1/b x bot"));
  assert.equal(body.match(/<\/details>/g).length, 1);
  assert.ok(!formatIssueBody({ ...report, system: null }).includes("<details>"));
});

// --- JWT and GitHub ----------------------------------------------------

test("the app JWT is RS256, signed by the app's key, and short-lived", () => {
  const jwt = signAppJwt("123456", crypto.createPrivateKey(privateKey), 1_700_000_000);
  const { ok, header, payload } = decodeJwt(jwt);
  assert.equal(ok, true);
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.deepEqual(payload, { iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: "123456" });
  assert.ok(!jwt.includes("=") && !jwt.includes("+") && !jwt.includes("/"), "base64url, no padding");
});

test("a PEM pasted with literal \\n still loads", () => {
  const flat = privateKey.trim().replace(/\n/g, "\\n");
  assert.equal(normalizePem(flat), privateKey.trim());
  const jwt = signAppJwt("1", crypto.createPrivateKey(normalizePem(flat)));
  assert.equal(decodeJwt(jwt).ok, true);
});

test("the GitHub client trades a JWT for a scoped token, creates the issue, and reuses the token", async () => {
  const gh = fakeGitHub();
  const client = createGitHubClient({ ...gh, apiUrl: "https://api.test", appId: "123456", privateKey, installationId: "987", owner: "PravdeepK", repo: "stem-player" });
  const first = await client.createIssue({ title: "T", body: "B", labels: ["bug", "from-app"] });
  await client.createIssue({ title: "T2", body: "B2", labels: ["bug", "from-app"] });

  assert.deepEqual(first, { number: 42, url: "https://github.com/PravdeepK/stem-player/issues/42", labels: ["bug", "from-app"] });
  assert.equal(gh.calls.length, 3, "one token, two issues");
  const [token, issue] = gh.calls;
  assert.equal(token.url, "https://api.test/app/installations/987/access_tokens");
  assert.equal(token.method, "POST");
  assert.deepEqual(token.body, { repositories: ["stem-player"], permissions: { issues: "write" } });
  const jwt = token.headers.Authorization.replace(/^Bearer /, "");
  assert.equal(decodeJwt(jwt).ok, true);
  assert.equal(decodeJwt(jwt).payload.iss, "123456");
  assert.equal(issue.url, "https://api.test/repos/PravdeepK/stem-player/issues");
  assert.equal(issue.headers.Authorization, "token ghs_test");
  assert.equal(issue.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.ok(issue.headers["User-Agent"]);
  assert.deepEqual(issue.body, { title: "T", body: "B", labels: ["bug", "from-app"] });
});

test("the GitHub client fetches a new token once the old one is nearly expired", async () => {
  let clock = Date.parse("2026-11-03T12:00:00Z");
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/access_tokens")) {
      return Response.json({ token: `t${calls.length}`, expires_at: new Date(clock + 60 * 60e3).toISOString() }, { status: 201 });
    }
    return Response.json({ number: 1, html_url: "https://github.com/PravdeepK/stem-player/issues/1", labels: [] }, { status: 201 });
  };
  const client = createGitHubClient({ fetch, now: () => clock, appId: "1", privateKey, installationId: "2", owner: "o", repo: "r" });
  await client.createIssue({ title: "a", body: "b", labels: [] });
  clock += 50 * 60e3;
  await client.createIssue({ title: "a", body: "b", labels: [] });
  clock += 6 * 60e3;
  await client.createIssue({ title: "a", body: "b", labels: [] });
  assert.equal(calls.filter((u) => u.endsWith("/access_tokens")).length, 2);
});

test("GitHub failures throw with the step and status", async () => {
  for (const [opts, step, status] of [
    [{ tokenStatus: 401 }, "token", 401],
    [{ issueStatus: 422 }, "issue", 422],
  ]) {
    const gh = fakeGitHub(opts);
    const client = createGitHubClient({ ...gh, appId: "1", privateKey, installationId: "2", owner: "o", repo: "r" });
    await assert.rejects(client.createIssue({ title: "a", body: "b", labels: [] }), (err) => err.step === step && err.status === status);
  }
});

// --- the relay handler ---------------------------------------------------

test("the relay posts a valid report as a labelled issue", async () => {
  const gh = fakeGitHub();
  const handle = createRelay({ env: { ...ENV, GITHUB_API_URL: "https://api.test/" }, fetch: gh.fetch, log: quiet });
  const res = await handle(request(goodBug()));
  assert.equal(res.status, 201);
  assert.deepEqual(parse(res), { ok: true, number: 42, url: "https://github.com/PravdeepK/stem-player/issues/42" });
  const issue = gh.calls.find((c) => c.url.endsWith("/issues"));
  assert.equal(issue.url, "https://api.test/repos/PravdeepK/stem-player/issues");
  assert.equal(issue.body.title, "Vocals drop out");
  assert.deepEqual(issue.body.labels, ["bug", "from-app"]);
  assert.equal(issue.body.body, formatIssueBody(validateReport(goodBug()).report));
});

test("the relay warns when GitHub drops a label", async () => {
  const warnings = [];
  const gh = fakeGitHub({ labels: ["bug"] });
  const handle = createRelay({ env: ENV, fetch: gh.fetch, log: { ...quiet, warn: (m) => warnings.push(m) } });
  assert.equal((await handle(request(goodBug()))).status, 201);
  assert.match(warnings[0], /missing labels: from-app/);
});

test("the relay turns away the wrong method, client, content type, size and JSON", async () => {
  const gh = fakeGitHub();
  const handle = createRelay({ env: ENV, fetch: gh.fetch, log: quiet });
  const cases = [
    [{ ...request(goodBug()), method: "GET" }, 405, "method_not_allowed"],
    [request(goodBug(), { "x-stem-player-key": "nope" }), 401, "bad_client"],
    [request(goodBug(), { "x-stem-player-key": undefined }), 401, "bad_client"],
    [request(goodBug(), { "content-type": "text/plain" }), 415, "unsupported_media_type"],
    [request(goodBug(), { "content-type": "application/jsonp" }), 415, "unsupported_media_type"],
    [request("x".repeat(MAX_BODY_BYTES + 1)), 413, "payload_too_large"],
    [{ ...request(goodBug()), tooLarge: true }, 413, "payload_too_large"],
    [request("{not json"), 400, "invalid_json"],
    [request(goodBug({ type: "nope" })), 400, "invalid_field"],
  ];
  for (const [req, status, code] of cases) {
    const res = await handle({ ...req, ip: `198.51.100.${status}` });
    assert.equal(res.status, status, code);
    assert.equal(parse(res).ok, false);
    assert.equal(parse(res).error, code);
    assert.equal(typeof parse(res).message, "string");
  }
  assert.equal(gh.calls.length, 0);
  const invalid = parse(await handle(request(goodBug({ title: "" }))));
  assert.equal(invalid.field, "title");
});

test("a filled honeypot looks like success but creates nothing", async () => {
  const gh = fakeGitHub();
  const handle = createRelay({ env: ENV, fetch: gh.fetch, log: quiet });
  const res = await handle(request(goodBug({ website: "http://spam.example" })));
  assert.equal(res.status, 200);
  assert.deepEqual(parse(res), { ok: true });
  assert.equal(gh.calls.length, 0);
});

test("the relay rate-limits each IP, and everyone together", async () => {
  let clock = 0;
  const gh = fakeGitHub();
  const handle = createRelay({ env: ENV, fetch: gh.fetch, now: () => clock, log: quiet });
  for (let i = 0; i < 5; i++) assert.equal((await handle(request(goodBug()))).status, 201);
  const limited = await handle(request(goodBug()));
  assert.equal(limited.status, 429);
  assert.equal(parse(limited).error, "rate_limited");
  assert.equal(parse(limited).retryAfter, 600);
  assert.equal(limited.headers["Retry-After"], "600");
  // Another IP still gets through; this one does once the window passes.
  assert.equal((await handle({ ...request(goodBug()), ip: "192.0.2.1" })).status, 201);
  clock += 10 * 60 * 1000;
  assert.equal((await handle(request(goodBug()))).status, 201);

  // 30 an hour across every IP.
  const overall = createRelay({ env: ENV, fetch: fakeGitHub().fetch, now: () => 0, log: quiet });
  for (let i = 0; i < 30; i++) assert.equal((await overall({ ...request(goodBug()), ip: `10.0.0.${i}` })).status, 201);
  assert.equal((await overall({ ...request(goodBug()), ip: "10.0.1.1" })).status, 429);
});

test("the rate limiter slides and forgets", () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000 }, () => clock);
  assert.equal(limiter.take("a").ok, true);
  clock = 500;
  assert.equal(limiter.take("a").ok, true);
  assert.deepEqual(limiter.take("a"), { ok: false, retryAfter: 1 });
  clock = 1001;
  assert.equal(limiter.take("a").ok, true, "the first hit has slid out");
  assert.equal(limiter.take("a").ok, false);
});

test("the relay says when it isn't configured, and when GitHub fails", async () => {
  const unset = createRelay({ env: {}, fetch: fakeGitHub().fetch, log: quiet });
  const res = await unset(request(goodBug()));
  assert.equal(res.status, 500);
  assert.equal(parse(res).error, "not_configured");

  const failing = createRelay({ env: ENV, fetch: fakeGitHub({ issueStatus: 403 }).fetch, log: quiet });
  const bad = await failing(request(goodBug()));
  assert.equal(bad.status, 502);
  assert.equal(parse(bad).error, "github_error");
});

test("browser origins are refused unless allowed", async () => {
  const handle = createRelay({ env: ENV, fetch: fakeGitHub().fetch, log: quiet });
  const res = await handle(request(goodBug(), { origin: "https://evil.example" }));
  assert.equal(res.status, 403);
  assert.equal(parse(res).error, "origin_not_allowed");
  const preflight = await handle({ method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(preflight.status, 403);
});

test("the caller's IP comes from proxy headers only when trusted", () => {
  const req = { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(clientIp(req, true), "1.1.1.1");
  assert.equal(clientIp({ ...req, headers: { ...req.headers, "x-real-ip": "3.3.3.3" } }, true), "3.3.3.3");
  assert.equal(clientIp(req, false), "127.0.0.1");
});

test("the Node adapter serves the handler over HTTP and stops reading oversized bodies", async () => {
  const gh = fakeGitHub();
  const server = http.createServer(nodeHandler(createRelay({ env: ENV, fetch: gh.fetch, log: quiet })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/feedback`;
  const headers = { "Content-Type": "application/json", "X-Stem-Player-Key": DEFAULT_CLIENT_KEY };
  try {
    const ok = await fetch(url, { method: "POST", headers, body: JSON.stringify(goodBug()) });
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).number, 42);
    assert.equal(ok.headers.get("cache-control"), "no-store");

    const big = await fetch(url, { method: "POST", headers, body: JSON.stringify(goodBug({ description: "x".repeat(20000) })) });
    assert.equal(big.status, 413);
  } finally {
    server.close();
  }
});
