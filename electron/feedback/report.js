"use strict";

// Everything about a feedback report that isn't the window: what system info
// says, sending it to the relay, and the fallbacks when that fails. No Electron
// here, so the tests can run it under plain node.
const { LIMITS, validateReport, formatIssueBody, systemLines } = require("./issue");

// The deployed relay (Vercel project stem-player-feedback, see feedback-relay/README.md).
// STEM_PLAYER_FEEDBACK_URL overrides it for testing.
const DEFAULT_FEEDBACK_URL = "https://stem-player-feedback.vercel.app/api/feedback";
const CLIENT_HEADER = "X-Stem-Player-Key";
// Must match the relay (feedback-relay/lib/relay.js). Public, so only a speed bump.
const CLIENT_KEY = "stem-player-desktop-v1";
const ISSUES_URL = "https://github.com/PravdeepK/stem-player/issues";
// GitHub answers 414 for very long links; stay well under the usual 8 KB.
const MAX_PREFILL_URL = 8000;
const TRUNCATED_NOTE = "\n\n[Cut short to fit in a link. The full report is on your clipboard.]";
const TIMEOUT_MS = 15000;

function feedbackUrl(env = process.env) {
  return env.STEM_PLAYER_FEEDBACK_URL || DEFAULT_FEEDBACK_URL;
}

// The interpreters main.js looks for on its own, which say nothing about the user.
const KNOWN_PYTHON = /^(python3?|\/opt\/homebrew\/bin\/python3|\/usr\/local\/bin\/python3|\/Library\/Frameworks\/Python\.framework\/Versions\/3\.\d+\/bin\/python3)$/;

/** Which Python makes stems, as a label rather than a path. */
function describePython({ python, engine, override } = {}) {
  if (python === undefined) return "unknown";
  if (!python) return "none found";
  if (engine && python === engine) return "stem engine";
  if (override && python === override) return "custom (STEM_PLAYER_PYTHON)";
  return KNOWN_PYTHON.test(python) ? python : "other";
}

/**
 * The system info a report can carry. `engine` is the engine's Python path or
 * null, and undefined (like `python`) when it couldn't be checked in time.
 */
function collectSystemInfo({ appVersion, macos, chip, memoryBytes, engine, python, override }) {
  const system = {
    app: appVersion,
    macos,
    chip: chip || "unknown",
    memory: memoryBytes ? `${Math.round(memoryBytes / 2 ** 30)} GB` : "unknown",
    engine: engine === undefined ? "unknown" : engine ? "installed" : "not installed",
    python: describePython({ python, engine, override }),
  };
  for (const key of Object.keys(system)) system[key] = String(system[key] || "unknown").slice(0, LIMITS.systemValue);
  return system;
}

/** The form's fields as the JSON the relay takes. */
function buildReport(type, fields, system) {
  const report = {
    type,
    title: String(fields.title || ""),
    description: String(fields.description || ""),
  };
  if (type === "bug" && fields.steps) report.steps = String(fields.steps);
  if (fields.includeSystem && system) report.system = system;
  report.website = String(fields.website || "");
  return report;
}

/** The report as the relay will clean it, or as close as it gets for a draft. */
function normalized(report) {
  const checked = validateReport(report);
  if (checked.ok) return checked.report;
  return {
    type: report.type,
    title: String(report.title || "").trim(),
    description: String(report.description || "").trim(),
    steps: String(report.steps || "").trim(),
    system: report.system || null,
  };
}

/** Title and body, for the clipboard or a preview. */
function reportText(report) {
  const clean = normalized(report);
  return `${clean.title}\n\n${formatIssueBody(clean)}`;
}

function cutTo(text, length) {
  let end = length;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--; // never split an emoji in half
  return text.slice(0, end).trimEnd() + TRUNCATED_NOTE;
}

/**
 * A link to GitHub's new-issue form for this report's template, with its
 * fields filled in. Too long a link gets the longest fields cut down to fit.
 * Resolves to { url, truncated }.
 */
function buildPrefillUrl(report, limit = MAX_PREFILL_URL) {
  const clean = normalized(report);
  const fields = {
    template: clean.type === "bug" ? "bug.yml" : "feature.yml",
    title: clean.title,
    description: clean.description,
  };
  if (clean.type === "bug" && clean.steps) fields.steps = clean.steps;
  const lines = systemLines(clean.system);
  if (lines.length) fields.system = lines.join("\n");

  const make = () =>
    `${ISSUES_URL}/new?` +
    Object.entries(fields)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");

  let url = make();
  if (url.length <= limit) return { url, truncated: false };

  const longestFirst = ["description", "steps"].filter((k) => fields[k]).sort((a, b) => fields[b].length - fields[a].length);
  for (const key of longestFirst) {
    const full = fields[key];
    let lo = 0;
    let hi = full.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      fields[key] = cutTo(full, mid);
      if (make().length <= limit) lo = mid;
      else hi = mid - 1;
    }
    fields[key] = cutTo(full, lo);
    url = make();
    if (url.length <= limit) return { url, truncated: true };
  }
  delete fields.system;
  return { url: make(), truncated: true };
}

const FRIENDLY = {
  offline: "Couldn't reach the feedback server. You might be offline, or it might be down.",
  timeout: "The feedback server didn't answer in time.",
  not_configured: "The feedback server isn't set up yet.",
  github_error: "GitHub didn't take the report just now.",
  payload_too_large: "The report is too long to send.",
  bad_client: "The feedback server didn't recognise this version of the app.",
  origin_not_allowed: "The feedback server didn't recognise this version of the app.",
};

/** What to tell the user when a submission fails. */
function friendlyError(code, { message, retryAfter, status } = {}) {
  if (code === "rate_limited") {
    const minutes = Math.max(1, Math.ceil((Number(retryAfter) || 600) / 60));
    return `Too many reports came from this network recently. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  if (code === "invalid_field" && message) return `The report was turned down: ${message}`;
  if (FRIENDLY[code]) return FRIENDLY[code];
  return `Something went wrong sending the report${status ? ` (HTTP ${status})` : ""}.`;
}

function isIssueUrl(url) {
  return typeof url === "string" && /^https:\/\/github\.com\/PravdeepK\/stem-player\/issues\/\d+$/.test(url);
}

/**
 * POST the report to the relay. Resolves to { ok: true, number, url } or
 * { ok: false, code, message }, never rejects.
 */
async function submitReport(report, { url = feedbackUrl(), fetch = globalThis.fetch, appVersion = "", timeoutMs = TIMEOUT_MS } = {}) {
  const fail = (code, extra = {}) => ({ ok: false, code, message: friendlyError(code, extra), retryAfter: extra.retryAfter });
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [CLIENT_HEADER]: CLIENT_KEY,
        "User-Agent": `StemPlayer/${appVersion}`,
      },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fail(err && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "offline");
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: a proxy page, or the relay isn't there at all */
  }
  if (res.status === 201 && body && body.ok && Number.isInteger(body.number) && isIssueUrl(body.url)) {
    return { ok: true, number: body.number, url: body.url };
  }
  if (body && typeof body.error === "string") {
    return fail(body.error, { message: body.message, retryAfter: body.retryAfter || res.headers.get("retry-after"), status: res.status });
  }
  return fail(res.status === 404 ? "offline" : "unexpected", { status: res.status });
}

module.exports = {
  DEFAULT_FEEDBACK_URL,
  CLIENT_HEADER,
  CLIENT_KEY,
  ISSUES_URL,
  MAX_PREFILL_URL,
  feedbackUrl,
  describePython,
  collectSystemInfo,
  buildReport,
  reportText,
  buildPrefillUrl,
  friendlyError,
  isIssueUrl,
  submitReport,
};
