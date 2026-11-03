"use strict";

// Turns a feedback POST from the app into a GitHub issue. The handler is plain
// data in, data out ({ status, headers, body }), so the Vercel function, the
// local dev server and the tests all drive the same code.
const { validateReport, formatIssueBody, issueLabels } = require("./issue");
const { createGitHubClient } = require("./github");

const OWNER = "PravdeepK";
const REPO = "stem-player";
const MAX_BODY_BYTES = 16 * 1024;
const CLIENT_HEADER = "x-stem-player-key";
// Also in electron/feedback/report.js. The repo is public, so this only turns
// away drive-by scanners: anyone can read it there, or pull it out of the app.
const DEFAULT_CLIENT_KEY = "stem-player-desktop-v1";

// Browser origins allowed to call the relay. The desktop app calls it from the
// main process, which sends no Origin, so this stays empty until the web app.
// WEB ORIGIN: add it here, e.g. "https://stem-player.example.com".
const ALLOWED_ORIGINS = new Set([]);

const PER_IP = { limit: 5, windowMs: 10 * 60 * 1000 };
const OVERALL = { limit: 30, windowMs: 60 * 60 * 1000 };

/**
 * A sliding-window counter per key. It lives in one function instance's
 * memory, so on serverless it resets on a cold start and isn't shared between
 * instances that run at once: a speed bump for ~10 people, not a guarantee.
 */
function createRateLimiter({ limit, windowMs }, now = Date.now) {
  const hits = new Map();
  return {
    /** Resolves to { ok: true } or { ok: false, retryAfter } in seconds. */
    take(key) {
      const t = now();
      const recent = (hits.get(key) || []).filter((at) => t - at < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0] + windowMs - t) / 1000)) };
      }
      recent.push(t);
      hits.set(key, recent);
      // Forget idle keys now and then so the map can't grow without bound.
      if (hits.size > 1000) {
        for (const [k, list] of hits) if (!list.some((at) => t - at < windowMs)) hits.delete(k);
      }
      return { ok: true };
    },
  };
}

const MESSAGES = {
  method_not_allowed: "Use POST.",
  origin_not_allowed: "This origin can't send feedback.",
  bad_client: "Feedback has to come from the Stem Player app.",
  rate_limited: "Too many reports for now. Try again later.",
  unsupported_media_type: "Send JSON.",
  payload_too_large: `The report is larger than ${MAX_BODY_BYTES / 1024} KB.`,
  invalid_json: "The report isn't valid JSON.",
  not_configured: "The feedback relay isn't set up yet.",
  github_error: "GitHub didn't take the issue. Try again in a bit.",
};

function json(status, body, extraHeaders = {}) {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function error(status, code, extra = {}, extraHeaders) {
  return json(status, { ok: false, error: code, message: extra.message || MESSAGES[code], ...extra }, extraHeaders);
}

/**
 * Build the handler. `env` holds GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY,
 * GITHUB_APP_INSTALLATION_ID, and optionally FEEDBACK_CLIENT_KEY and
 * GITHUB_API_URL (for tests against a mock). Returns
 * async ({ method, headers, body, ip, tooLarge }) => { status, headers, body }.
 */
function createRelay({ env = process.env, fetch = globalThis.fetch, now = Date.now, log = console } = {}) {
  const perIp = createRateLimiter(PER_IP, now);
  const overall = createRateLimiter(OVERALL, now);
  const clientKey = env.FEEDBACK_CLIENT_KEY || DEFAULT_CLIENT_KEY;
  let github = null;

  function client() {
    if (github) return github;
    const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID } = env;
    if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY || !GITHUB_APP_INSTALLATION_ID) return null;
    github = createGitHubClient({
      apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
      appId: GITHUB_APP_ID,
      privateKey: GITHUB_APP_PRIVATE_KEY,
      installationId: GITHUB_APP_INSTALLATION_ID,
      owner: OWNER,
      repo: REPO,
      fetch,
      now,
    });
    return github;
  }

  return async function handle(req) {
    const headers = req.headers || {};
    const origin = headers.origin;
    const cors = {};
    if (origin) {
      if (!ALLOWED_ORIGINS.has(origin)) return error(403, "origin_not_allowed");
      Object.assign(cors, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": `Content-Type, ${CLIENT_HEADER}`,
        Vary: "Origin",
      });
      if (req.method === "OPTIONS") return { status: 204, headers: cors, body: "" };
    }

    if (req.method !== "POST") return error(405, "method_not_allowed", {}, { Allow: "POST", ...cors });
    if (headers[CLIENT_HEADER] !== clientKey) return error(401, "bad_client", {}, cors);

    // Count every request that gets this far, valid or not.
    const ip = req.ip || "unknown";
    for (const limiter of [perIp, overall]) {
      const take = limiter.take(limiter === perIp ? ip : "*");
      if (!take.ok) {
        return error(429, "rate_limited", { retryAfter: take.retryAfter }, { "Retry-After": String(take.retryAfter), ...cors });
      }
    }

    if (!/^application\/json\s*(;|$)/i.test(headers["content-type"] || "")) {
      return error(415, "unsupported_media_type", {}, cors);
    }
    if (req.tooLarge || Buffer.byteLength(req.body || "") > MAX_BODY_BYTES) return error(413, "payload_too_large", {}, cors);

    let input;
    try {
      input = JSON.parse(req.body);
    } catch {
      return error(400, "invalid_json", {}, cors);
    }

    // Hidden in the form: people leave it empty, form-filling bots don't.
    // They get a success that creates nothing, so there's nothing to learn.
    if (input && typeof input.website === "string" && input.website.trim()) {
      log.warn("[feedback] honeypot filled, dropped");
      return json(200, { ok: true }, cors);
    }

    const checked = validateReport(input);
    if (!checked.ok) return error(400, "invalid_field", { field: checked.field, message: checked.message }, cors);
    const { report } = checked;

    const gh = client();
    if (!gh) {
      log.error("[feedback] missing GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY or GITHUB_APP_INSTALLATION_ID");
      return error(500, "not_configured", {}, cors);
    }

    const labels = issueLabels(report.type);
    let issue;
    try {
      issue = await gh.createIssue({ title: report.title, body: formatIssueBody(report), labels });
    } catch (err) {
      log.error("[feedback]", err.message);
      return error(502, "github_error", {}, cors);
    }
    const dropped = labels.filter((l) => !issue.labels.includes(l));
    if (dropped.length) log.warn(`[feedback] #${issue.number} is missing labels: ${dropped.join(", ")}`);
    log.log(`[feedback] created #${issue.number} (${report.type})`);
    return json(201, { ok: true, number: issue.number, url: issue.url }, cors);
  };
}

/** The caller's IP. Only trust proxy headers behind a proxy that sets them, like Vercel. */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const real = req.headers["x-real-ip"];
    if (real) return String(real).trim();
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/** Read a Node request body as text, stopping early once it's too large. */
async function readBody(req, max = MAX_BODY_BYTES) {
  const declared = Number(req.headers["content-length"]);
  if (declared > max) return { tooLarge: true, body: "" };
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) return { tooLarge: true, body: "" };
    chunks.push(chunk);
  }
  return { tooLarge: false, body: Buffer.concat(chunks).toString("utf8") };
}

/** Wrap the handler as a Node (req, res) function, the shape Vercel and http.createServer call. */
function nodeHandler(handle, { trustProxy = false } = {}) {
  return async (req, res) => {
    let result;
    try {
      const { body, tooLarge } = req.method === "POST" ? await readBody(req) : { body: "", tooLarge: false };
      result = await handle({ method: req.method, headers: req.headers, body, tooLarge, ip: clientIp(req, trustProxy) });
    } catch (err) {
      console.error("[feedback] unexpected:", err);
      result = error(500, "internal", { message: "Something went wrong in the relay." });
    }
    res.statusCode = result.status;
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    res.end(result.body);
  };
}

module.exports = {
  createRelay,
  createRateLimiter,
  nodeHandler,
  readBody,
  clientIp,
  ALLOWED_ORIGINS,
  MAX_BODY_BYTES,
  CLIENT_HEADER,
  DEFAULT_CLIENT_KEY,
  PER_IP,
  OVERALL,
};
