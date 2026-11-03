# Stem Player feedback relay

A small serverless function that turns **Help › Report a Bug…** and
**Help › Request a Feature…** in the app into issues on
[PravdeepK/stem-player](https://github.com/PravdeepK/stem-player/issues).

The app can't hold a GitHub token (anyone could pull it out), so it posts to
this relay instead. The relay holds a GitHub App's private key, signs a JWT
with it, trades that for a one-hour installation token scoped to this repo's
issues, and creates the issue. It has no dependencies: plain `fetch` and
`node:crypto`.

```
app (main process) ──POST /api/feedback──▶ relay (Vercel) ──GitHub App──▶ issue
```

## Setup

You need to do this once. It takes about ten minutes.

### 1. Create the GitHub App

Go to <https://github.com/settings/apps/new> and fill in:

| Field | Value |
| --- | --- |
| GitHub App name | `Stem Player Feedback` (it must be unique across GitHub, so add something if it's taken) |
| Homepage URL | `https://github.com/PravdeepK/stem-player` |
| Callback URL, Setup URL | leave empty |
| Webhook | untick **Active** (no webhook) |
| Repository permissions › **Issues** | **Read and write** (Metadata: Read-only is added automatically) |
| Every other permission | No access |
| Where can this GitHub App be installed? | **Only on this account** |

Click **Create GitHub App**.

### 2. Note the App ID and generate the private key

- On the app's **General** page, copy the **App ID** (a number). This is
  `GITHUB_APP_ID`.
- Scroll down to **Private keys** and click **Generate a private key**. A
  `.pem` file downloads. Its contents are `GITHUB_APP_PRIVATE_KEY`. Keep it out
  of the repo. You can delete the file once it's in Vercel.

### 3. Install the app on the stem-player repo only

- In the app's settings sidebar, click **Install App**, then **Install** next to
  your account.
- Choose **Only select repositories**, pick **stem-player**, and click
  **Install**.

### 4. Find the installation ID

After installing, GitHub opens a URL like
`https://github.com/settings/installations/12345678`. That number is
`GITHUB_APP_INSTALLATION_ID`. You can find the page again later under
**Settings › Applications › Installed GitHub Apps › Configure**.

### 5. Make sure the labels exist

The relay labels each issue `bug` or `enhancement`, plus `from-app`.

- **Can the app apply labels?** It should. GitHub's
  [permission table for Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
  lists creating an issue, adding labels and creating labels all under
  **Issues: write**. The REST docs also say "only users with push access can
  set labels" and that labels are silently dropped otherwise. That reads as a
  rule for users, and an App with Issues write meets the label permission.
  Check the first real issue anyway. If a label is missing, the relay logs it
  (see below).
- **Are missing labels created automatically?** GitHub's docs don't say, so
  don't rely on it. Create them first.

`bug` and `enhancement` are GitHub's default labels, so check they're still at
<https://github.com/PravdeepK/stem-player/labels>. Then create `from-app`:

```sh
gh label create from-app --repo PravdeepK/stem-player --color 5319e7 \
  --description "Sent from the app's Help menu"
```

If GitHub ever drops a label, the issue is still created and the relay logs
`#N is missing labels: …` in Vercel's function logs.

### 6. Deploy to Vercel

In the dashboard:

1. **Add New › Project**, then import `PravdeepK/stem-player`.
2. **Root Directory:** `feedback-relay`. **Framework Preset:** Other. Leave the
   build and output settings empty.
3. **Environment Variables** (for Production):

   | Name | Value |
   | --- | --- |
   | `GITHUB_APP_ID` | the App ID from step 2 |
   | `GITHUB_APP_PRIVATE_KEY` | the whole `.pem` file, from `-----BEGIN RSA PRIVATE KEY-----` to `-----END RSA PRIVATE KEY-----`. Multi-line is fine; so is one line with literal `\n`s |
   | `GITHUB_APP_INSTALLATION_ID` | the number from step 4 |
   | `FEEDBACK_CLIENT_KEY` | optional. Only set it if you also change `CLIENT_KEY` in `electron/feedback/report.js`, and make the two match |

4. **Deploy.** Optionally, under **Settings › Git**, turn on skipping
   deployments when nothing in `feedback-relay/` changed, so app commits don't
   redeploy it.

Or with the CLI, from `feedback-relay/`:

```sh
vercel link                      # create the project; root directory is this folder
vercel env add GITHUB_APP_ID production
vercel env add GITHUB_APP_PRIVATE_KEY production < path/to/key.pem
vercel env add GITHUB_APP_INSTALLATION_ID production
vercel --prod
```

The function is at `https://<project>.vercel.app/api/feedback`. To check it's up
without creating an issue, send an empty report. It should answer
`400 invalid_field`:

```sh
curl -i -X POST https://<project>.vercel.app/api/feedback \
  -H 'Content-Type: application/json' \
  -H 'X-Stem-Player-Key: stem-player-desktop-v1' \
  -d '{"type":"bug"}'
```

A `500 not_configured` means an env var is missing. Redeploy after adding it.

### 7. Point the app at it

Put the real URL in `DEFAULT_FEEDBACK_URL` in
[`electron/feedback/report.js`](../electron/feedback/report.js). It's marked
`PLACEHOLDER`. Then build and ship the app. Until then, the app's form fails
with "Couldn't reach the feedback server" and offers **Copy report** and
**Open on GitHub instead**.

## API

`POST /api/feedback` with `Content-Type: application/json` and the header
`X-Stem-Player-Key`. The body can be up to 16 KB:

```json
{
  "type": "bug",
  "title": "Vocals stem goes silent",
  "description": "After about a minute…",
  "steps": "1. Open a song\n2. …",
  "system": { "app": "0.1.0", "macos": "15.1.0", "chip": "Apple M2", "memory": "16 GB", "engine": "installed", "python": "stem engine" },
  "website": ""
}
```

| Field | Rules |
| --- | --- |
| `type` | `bug` or `feature` |
| `title` | 3–120 characters, on one line |
| `description` | 3–5000 characters |
| `steps` | optional, up to 3000 characters, bugs only |
| `system` | optional. Only the keys above are allowed, each a string of up to 100 characters made of letters, digits and `.,()+:/~-` |
| `website` | the honeypot. It must be empty |

Unknown fields are rejected. The issue body is markdown: Description, then
Steps to reproduce, then System info in a collapsed `<details>` block. User
text keeps its formatting, with two exceptions. Raw HTML is escaped (`<`
becomes `&lt;`), so nothing can close the details block or hide text.
`@mentions` are wrapped in code, so nobody gets pinged.

**Success:** `201 {"ok": true, "number": 12, "url": "https://github.com/PravdeepK/stem-player/issues/12"}`

**Errors:** `{"ok": false, "error": "<code>", "message": "…"}`. The app maps each
code to a friendly message:

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_json` | the body isn't JSON |
| 400 | `invalid_field` | the report fails validation. It also returns `field` |
| 401 | `bad_client` | the `X-Stem-Player-Key` header is missing or wrong |
| 403 | `origin_not_allowed` | a browser origin that isn't allowed |
| 405 | `method_not_allowed` | the request isn't a POST |
| 413 | `payload_too_large` | the body is over 16 KB |
| 415 | `unsupported_media_type` | the body isn't sent as JSON |
| 429 | `rate_limited` | too many requests. It also returns `retryAfter` (seconds) and a `Retry-After` header |
| 500 | `not_configured` | a GitHub App env var is missing |
| 502 | `github_error` | GitHub refused or failed. Details go to the function log only |

## Abuse protection, honestly

This is sized for about ten people, not the open internet.

- **Rate limit:** 5 reports per IP per 10 minutes, and 30 per hour overall. It's
  in memory, so it resets whenever Vercel starts a fresh instance, and
  instances running at the same time don't share counts. For a hard limit, add
  a Vercel Firewall rate-limit rule on `/api/feedback`, or move the counters to
  a store like Upstash Redis.
- **Honeypot:** the form has a hidden `website` field. A request that fills it
  gets a fake `200 {"ok": true}`, and no issue is created.
- **Shared header:** `X-Stem-Player-Key` is only a speed bump. The value is in
  this public repo and in every copy of the app, so anyone determined can send
  it. It stops drive-by scanners, nothing more.
- **Scoped token:** each installation token is narrowed to this one repo with
  `issues: write`. A leak of the relay's token can't touch code or other
  repos. If the private key ever leaks, generate a new one on the app's page,
  update `GITHUB_APP_PRIVATE_KEY` in Vercel, redeploy, and delete the old key.
- **Logs:** the relay logs issue numbers and errors. It never logs report
  content.

The files are served from a public repo, and Vercel may also serve the
non-`api/` files in this folder as static files. That's harmless because
nothing in them is secret.

## CORS and the future web app

The desktop app sends from Electron's main process, which sets no `Origin`
header, so CORS doesn't come into it. Requests that come with an `Origin`
are refused unless it's listed in `ALLOWED_ORIGINS` in
[`lib/relay.js`](lib/relay.js) (look for `WEB ORIGIN`). When the web version
ships, add its origin there and the relay will answer preflights for it.

## Running and testing locally

```sh
# the relay, against a mock (or real) GitHub API
GITHUB_API_URL=http://127.0.0.1:9999 GITHUB_APP_ID=1 GITHUB_APP_INSTALLATION_ID=1 \
GITHUB_APP_PRIVATE_KEY="$(cat key.pem)" node feedback-relay/dev-server.js

# the app, pointed at it
STEM_PLAYER_FEEDBACK_URL=http://127.0.0.1:8787/api/feedback npm run electron
```

From the repo root, `npm test` runs the unit tests, including the relay's
(`test/feedbackRelay.test.mjs`). `npm run test:e2e:feedback` runs the end-to-end
test. It starts a mock GitHub API and this relay, then drives the real feedback
window. It never contacts GitHub.

## Files

- `api/feedback.js`: the Vercel function
- `lib/relay.js`: request handling, validation order, rate limits, CORS, and the Node adapter
- `lib/github.js`: JWT signing, the installation token, and issue creation
- `lib/issue.js`: field rules and the issue body. A byte-identical copy lives at
  `electron/feedback/issue.js`, and a test fails if the two differ
- `dev-server.js`: the relay as a local HTTP server
