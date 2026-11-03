"use strict";

// What a feedback report may contain and how it reads as a GitHub issue.
// Shared by the relay and the app, which keeps a byte-identical copy at
// electron/feedback/issue.js (the relay deploys on its own, so it can't import
// it). test/feedbackRelay.test.mjs fails if the two drift apart.

const TYPES = { bug: "bug", feature: "enhancement" };
const FROM_APP_LABEL = "from-app";

const LIMITS = {
  title: { min: 3, max: 120 },
  description: { min: 3, max: 5000 },
  steps: { min: 0, max: 3000 },
  systemValue: 100,
};

// Everything system info may say, in the order it's shown. Never paths, song
// names or logs.
const SYSTEM_FIELDS = [
  ["app", "App version"],
  ["macos", "macOS"],
  ["chip", "Chip"],
  ["memory", "Memory"],
  ["engine", "Stem engine"],
  ["python", "Python"],
];

const REPORT_KEYS = new Set(["type", "title", "description", "steps", "system", "website"]);

// Control characters other than tab and newline.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
// System values are plain facts like "Apple M2 Pro", so anything else goes.
const NOT_SYSTEM = /[^\w .,()+:/~-]/g;

function cleanText(value) {
  return String(value).replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
}

function cleanLine(value) {
  return String(value).replace(/\s+/g, " ").replace(CONTROL, "").trim();
}

/**
 * User text as issue markdown: no raw HTML (so nothing can close the system
 * info block or hide text), and @mentions in code so nobody gets pinged.
 */
function escapeMarkdown(text) {
  return text.replace(/</g, "&lt;").replace(/(^|[^\w`])@([a-z0-9][a-z0-9-]*)/gi, "$1`@$2`");
}

/**
 * Check a report strictly. Resolves to { ok: true, report } with trimmed
 * fields, or { ok: false, field, message }.
 */
function validateReport(input) {
  const fail = (field, message) => ({ ok: false, field, message });
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("body", "Expected a JSON object.");
  for (const key of Object.keys(input)) {
    if (!REPORT_KEYS.has(key)) return fail(key, `Unknown field "${key}".`);
  }
  if (!Object.prototype.hasOwnProperty.call(TYPES, input.type)) return fail("type", 'type must be "bug" or "feature".');

  const text = (field, required) => {
    const value = input[field];
    if (value === undefined || value === null) return required ? fail(field, `${field} is required.`) : "";
    if (typeof value !== "string") return fail(field, `${field} must be a string.`);
    const clean = field === "title" ? cleanLine(value) : cleanText(value);
    const { min, max } = LIMITS[field];
    if (clean.length > max) return fail(field, `${field} must be at most ${max} characters.`);
    if (clean.length < Math.max(min, required ? 1 : 0)) {
      return fail(field, `${field} must be at least ${Math.max(min, 1)} characters.`);
    }
    return clean;
  };

  const title = text("title", true);
  if (typeof title !== "string") return title;
  const description = text("description", true);
  if (typeof description !== "string") return description;
  const steps = text("steps", false);
  if (typeof steps !== "string") return steps;
  if (steps && input.type !== "bug") return fail("steps", "Only bug reports have steps to reproduce.");

  let system = null;
  if (input.system !== undefined && input.system !== null) {
    if (typeof input.system !== "object" || Array.isArray(input.system)) return fail("system", "system must be an object.");
    const known = new Map(SYSTEM_FIELDS);
    system = {};
    for (const [key, value] of Object.entries(input.system)) {
      if (!known.has(key)) return fail("system", `Unknown system field "${key}".`);
      if (typeof value !== "string") return fail("system", `system.${key} must be a string.`);
      const clean = cleanLine(value).replace(NOT_SYSTEM, "");
      if (clean.length > LIMITS.systemValue) return fail("system", `system.${key} is too long.`);
      if (clean) system[key] = clean;
    }
  }

  if (input.website !== undefined && typeof input.website !== "string") return fail("website", "website must be a string.");

  return { ok: true, report: { type: input.type, title, description, steps, system } };
}

/** The system info as "Label: value" lines, in a fixed order. */
function systemLines(system) {
  if (!system) return [];
  return SYSTEM_FIELDS.filter(([key]) => system[key]).map(([key, label]) => `${label}: ${system[key]}`);
}

/** A validated report as the issue's markdown body. */
function formatIssueBody(report) {
  const parts = ["### Description", "", escapeMarkdown(report.description)];
  if (report.type === "bug" && report.steps) {
    parts.push("", "### Steps to reproduce", "", escapeMarkdown(report.steps));
  }
  const lines = systemLines(report.system);
  if (lines.length) {
    parts.push("", "<details>", "<summary>System info</summary>", "");
    for (const line of lines) parts.push(`- ${line}`);
    parts.push("", "</details>");
  }
  return parts.join("\n") + "\n";
}

function issueLabels(type) {
  return [TYPES[type], FROM_APP_LABEL];
}

module.exports = {
  LIMITS,
  SYSTEM_FIELDS,
  TYPES,
  FROM_APP_LABEL,
  validateReport,
  formatIssueBody,
  systemLines,
  issueLabels,
  escapeMarkdown,
};
