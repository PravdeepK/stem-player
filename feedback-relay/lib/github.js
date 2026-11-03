"use strict";

// Talks to GitHub as a GitHub App: sign a short-lived JWT with the app's private
// key, trade it for an installation token, then create the issue with that.
const crypto = require("crypto");

const API_VERSION = "2022-11-28";
const USER_AGENT = "stem-player-feedback-relay";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/**
 * An RS256 JWT for the GitHub App. Backdated a minute for clock drift and
 * valid for nine, under GitHub's ten-minute maximum.
 */
function signAppJwt(appId, privateKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: String(appId) };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

/** Vercel env vars often hold a PEM pasted with literal "\n"s. */
function normalizePem(pem) {
  return String(pem || "").replace(/\\n/g, "\n").trim();
}

class GitHubError extends Error {
  constructor(step, status, detail) {
    super(`GitHub ${step} failed with ${status}: ${detail}`);
    this.step = step;
    this.status = status;
  }
}

function headers(auth) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: auth,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": API_VERSION,
  };
}

async function detail(res) {
  try {
    const body = await res.json();
    return body && body.message ? String(body.message).slice(0, 200) : "no message";
  } catch {
    return "unreadable response";
  }
}

/**
 * A client for one repo. Installation tokens last an hour, so a warm function
 * reuses its token until five minutes before it expires.
 */
function createGitHubClient({ apiUrl = "https://api.github.com", appId, privateKey, installationId, owner, repo, fetch = globalThis.fetch, now = Date.now }) {
  const key = crypto.createPrivateKey(normalizePem(privateKey));
  let cached = null;

  async function installationToken() {
    if (cached && cached.expiresAt - now() > 5 * 60 * 1000) return cached.token;
    const jwt = signAppJwt(appId, key, Math.floor(now() / 1000));
    const res = await fetch(`${apiUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      method: "POST",
      headers: headers(`Bearer ${jwt}`),
      // Narrowed to this repo's issues, whatever else the app is ever granted.
      body: JSON.stringify({ repositories: [repo], permissions: { issues: "write" } }),
    });
    if (res.status !== 201) throw new GitHubError("token", res.status, await detail(res));
    const body = await res.json();
    if (!body || typeof body.token !== "string") throw new GitHubError("token", res.status, "no token");
    const expiresAt = Date.parse(body.expires_at);
    cached = { token: body.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + 50 * 60 * 1000 };
    return cached.token;
  }

  /** Resolves to { number, url, labels }. */
  async function createIssue({ title, body, labels }) {
    const token = await installationToken();
    const res = await fetch(`${apiUrl}/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: headers(`token ${token}`),
      body: JSON.stringify({ title, body, labels }),
    });
    if (res.status === 401) cached = null;
    if (res.status !== 201) throw new GitHubError("issue", res.status, await detail(res));
    const issue = await res.json();
    return {
      number: issue.number,
      url: issue.html_url,
      labels: (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
    };
  }

  return { createIssue, installationToken };
}

module.exports = { createGitHubClient, signAppJwt, normalizePem, GitHubError };
