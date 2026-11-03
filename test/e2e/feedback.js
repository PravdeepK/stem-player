// End-to-end test of Help › Report a Bug…, without GitHub: a mock GitHub API
// runs here, the real relay (feedback-relay/dev-server.js) runs as a child
// process pointed at it, and the real app is pointed at the relay with
// STEM_PLAYER_FEEDBACK_URL. The harness opens the form from the app menu,
// types into it, clicks Post, and checks what the mock received.
// Run with `npm run test:e2e:feedback`. FEEDBACK_SHOTS=<dir> keeps the screenshots there.
const { app, BrowserWindow, Menu, clipboard, shell } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "stem-player-feedback-e2e-"));
app.setPath("userData", path.join(WORK, "userData"));
const OUT = process.env.FEEDBACK_SHOTS || path.join(WORK, "shots");
fs.mkdirSync(OUT, { recursive: true });

const opened = [];
shell.openExternal = async (url) => opened.push(url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
};

// --- a mock GitHub API ------------------------------------------------------
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const APP_ID = "424242";
const INSTALLATION_ID = "777";
const mock = { tokens: 0, issues: [], badAuth: 0, failIssues: false, next: 100 };

function verifyJwt(auth) {
  const jwt = String(auth || "").replace(/^Bearer /, "");
  const [h, p, s] = jwt.split(".");
  if (!s) return false;
  const signed = crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  const now = Math.floor(Date.now() / 1000);
  return signed && claims.iss === APP_ID && claims.iat <= now && claims.exp > now && claims.exp - claims.iat <= 600;
}

const github = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      if (!verifyJwt(req.headers.authorization)) {
        mock.badAuth++;
        return reply(401, { message: "A JSON web token could not be decoded" });
      }
      mock.tokens++;
      return reply(201, { token: "ghs_mock", expires_at: new Date(Date.now() + 3600e3).toISOString() });
    }
    if (req.method === "POST" && req.url === "/repos/PravdeepK/stem-player/issues") {
      if (req.headers.authorization !== "token ghs_mock") {
        mock.badAuth++;
        return reply(401, { message: "Bad credentials" });
      }
      if (mock.failIssues) return reply(503, { message: "Service unavailable" });
      const issue = JSON.parse(raw);
      mock.issues.push({ ...issue, headers: req.headers });
      const number = ++mock.next;
      return reply(201, {
        number,
        html_url: `https://github.com/PravdeepK/stem-player/issues/${number}`,
        labels: issue.labels.map((name) => ({ name })),
      });
    }
    reply(404, { message: "Not Found" });
  });
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// --- the real relay, as its own process ---------------------------------
let relay = null;
const relayLog = [];
function startRelay(githubUrl) {
  return new Promise((resolve, reject) => {
    relay = spawn(process.execPath, [path.join(ROOT, "feedback-relay", "dev-server.js")], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PORT: "0",
        GITHUB_API_URL: githubUrl,
        GITHUB_APP_ID: APP_ID,
        // As pasted into Vercel: one line with literal \n.
        GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
        GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID,
      },
    });
    relay.stdout.setEncoding("utf8");
    relay.stderr.setEncoding("utf8");
    relay.stderr.on("data", (d) => relayLog.push(d.trim()));
    relay.stdout.on("data", (d) => {
      relayLog.push(d.trim());
      const m = d.match(/listening on (\S+)/);
      if (m) resolve(m[1]);
    });
    relay.on("exit", (code) => reject(new Error(`relay exited with ${code}`)));
  });
}

// --- driving the window ---------------------------------------------------
function feedbackWindow() {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith("/feedback/form.html"));
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  return null;
}

function driver(win) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code);
  const center = async (selector) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  return {
    wc,
    js,
    async click(selector) {
      const [x, y] = await center(selector);
      wc.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
      await sleep(40);
      wc.sendInputEvent({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
      await sleep(60);
      wc.sendInputEvent({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
      await sleep(200);
    },
    async type(selector, text) {
      await this.click(selector);
      await wc.insertText(text);
      await sleep(100);
    },
    async shot(name) {
      await sleep(400);
      const file = path.join(OUT, `${name}.png`);
      fs.writeFileSync(file, (await wc.capturePage()).toPNG());
      console.log(`     screenshot: ${file}`);
    },
    visible: (selector) => js(`!document.querySelector(${JSON.stringify(selector)}).closest("[hidden]")`),
    text: (selector) => js(`document.querySelector(${JSON.stringify(selector)}).textContent`),
  };
}

async function openFromMenu(id) {
  Menu.getApplicationMenu().getMenuItemById(id).click();
  const win = await until(() => {
    const w = feedbackWindow();
    return w && w.isVisible() ? w : null;
  });
  if (!win) throw new Error(`${id} didn't open the feedback window`);
  win.webContents.setBackgroundThrottling(false);
  const d = driver(win);
  await until(() => d.js(`document.getElementById("system-lines").textContent.length > 0`));
  return d;
}

const TITLE = "Vocals stem goes silent";
const DESCRIPTION = "After about a minute the vocals stem stops playing, but the others keep going. cc @octocat";
const STEPS = "1. Open a song\n2. Press play\n3. Wait a minute";

async function run() {
  const githubUrl = `http://127.0.0.1:${await listen(github)}`;
  const relayUrl = await startRelay(githubUrl);
  process.env.STEM_PLAYER_FEEDBACK_URL = relayUrl;
  console.log(`mock GitHub ${githubUrl}, relay ${relayUrl}`);

  require(path.join(ROOT, "electron", "main.js"));
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows()[0]);

  const help = Menu.getApplicationMenu().items.find((i) => i.role === "help");
  check("the Help menu has both items", !!help && help.submenu.items.map((i) => i.label).join("|") === "Report a Bug…|Request a Feature…");

  // --- the bug form, and a successful post -------------------------------
  let f = await openFromMenu("report-bug");
  check("opens as a sheet on the main window", f.wc.getOwnerBrowserWindow().getParentWindow() === BrowserWindow.getAllWindows().find((w) => w !== f.wc.getOwnerBrowserWindow()));
  check("heading says Report a Bug", (await f.text("#heading")) === "Report a Bug");
  check("says it's public", (await f.text(".public")) === "This is posted publicly on GitHub.");
  const lines = await f.text("#system-lines");
  const { version } = require(path.join(ROOT, "package.json"));
  check("shows the system info it will send", lines.startsWith(`App version: ${version}\n`) && /^App version: .+\nmacOS: .+\nChip: .+\nMemory: \d+ GB\nStem engine: .+\nPython: .+$/.test(lines), JSON.stringify(lines));
  check("system info holds no home paths", !lines.includes(os.homedir()));
  check("the page has no Node", (await f.js("typeof require + typeof process")) === "undefinedundefined");
  await f.js(`location.href = "https://example.com/"`);
  await sleep(300);
  const opened1 = await f.js(`String(window.open("https://example.com/"))`);
  check("the window can't navigate or open others", f.wc.getURL().endsWith("/feedback/form.html") && opened1 === "null" && BrowserWindow.getAllWindows().length === 2);

  await f.click("#submit");
  check("empty fields are caught before sending", (await f.visible("#title-error")) && mock.issues.length === 0);

  await f.type("#title", TITLE);
  await f.type("#description", DESCRIPTION);
  await f.type("#steps", STEPS);
  await f.click("#preview summary");
  await until(() => f.js(`document.getElementById("preview-text").textContent.includes("Steps to reproduce")`));
  const preview = await f.text("#preview-text");
  check("the preview shows the whole issue", preview.startsWith(`${TITLE}\n\n### Description`) && preview.includes("<summary>System info</summary>"));
  await f.click("#preview summary");
  await f.shot("feedback-1-form");

  await f.click("#submit");
  await until(() => f.visible("#done-view"));
  check("success shows the issue number", (await f.text("#issue-link")) === "issue #101", await f.text("#issue-link"));
  check("success shows the link", (await f.text("#issue-url")) === "https://github.com/PravdeepK/stem-player/issues/101");
  await f.shot("feedback-2-success");

  const issue = mock.issues[0];
  check("the mock got exactly one issue", mock.issues.length === 1 && mock.tokens === 1 && mock.badAuth === 0);
  check("issue title", issue && issue.title === TITLE);
  check("issue labels", issue && JSON.stringify(issue.labels) === '["bug","from-app"]');
  const body = (issue && issue.body) || "";
  check(
    "issue body has the description, steps and collapsed system info",
    body.includes("### Description\n\nAfter about a minute") &&
      body.includes("### Steps to reproduce\n\n1. Open a song\n2. Press play\n3. Wait a minute") &&
      /<details>\n<summary>System info<\/summary>\n\n- App version: /.test(body) &&
      body.includes("- Python: ")
  );
  check("issue body defuses the mention", body.includes("cc `@octocat`") && body.match(/<\/details>/g).length === 1);
  check("issue body has no paths", !body.includes(os.homedir()) && !body.includes("/Users/"));
  check("the relay authenticated with the app's JWT and token", issue && issue.headers.authorization === "token ghs_mock");

  await f.click("#issue-link");
  check("the issue link opens in the browser", opened.at(-1) === "https://github.com/PravdeepK/stem-player/issues/101");
  await f.click("#done");
  check("Done closes the window", !!(await until(() => !feedbackWindow())));

  // --- the feature form ---------------------------------------------------
  f = await openFromMenu("request-feature");
  check("feature form has its own heading and no steps", (await f.text("#heading")) === "Request a Feature" && !(await f.visible("#steps")));
  await f.type("#title", "Loop a section");
  await f.type("#description", "Let me loop the chorus while I practise.");
  await f.click("#include-system");
  check("unticking system info says nothing will be sent", (await f.visible("#system-off")) && !(await f.visible("#system-lines")));
  await f.click("#submit");
  await until(() => f.visible("#done-view"));
  const feature = mock.issues[1];
  check(
    "feature request is labelled enhancement and has no system info",
    feature && JSON.stringify(feature.labels) === '["enhancement","from-app"]' && !feature.body.includes("System info")
  );
  await f.click("#done");
  await until(() => !feedbackWindow());

  // --- failures: GitHub down, then the relay gone ---------------------------
  f = await openFromMenu("report-bug");
  await f.type("#title", TITLE);
  await f.type("#description", DESCRIPTION);
  await f.type("#steps", STEPS);
  mock.failIssues = true;
  await f.click("#submit");
  await until(() => f.visible("#failure"));
  check("GitHub failing says so", (await f.text("#failure-text")) === "GitHub didn't take the report just now.", await f.text("#failure-text"));

  relay.removeAllListeners("exit");
  relay.kill();
  await sleep(300);
  await f.click("#submit");
  await until(async () => (await f.text("#failure-text")).startsWith("Couldn't reach"));
  check("offline says so", (await f.text("#failure-text")).startsWith("Couldn't reach the feedback server"), await f.text("#failure-text"));
  check(
    "the text is kept",
    (await f.js(`document.getElementById("title").value`)) === TITLE && (await f.js(`document.getElementById("steps").value`)) === STEPS
  );
  check("failure offers copy and open on GitHub", (await f.visible("#copy")) && (await f.visible("#open-github")));

  clipboard.writeText("");
  await f.click("#copy");
  const copied = clipboard.readText();
  check("Copy report puts the full report on the clipboard", copied.startsWith(`${TITLE}\n\n### Description`) && copied.includes("3. Wait a minute") && copied.includes("System info"));

  await f.click("#open-github");
  const prefill = new URL(opened.at(-1));
  check(
    "Open on GitHub opens the prefilled bug form",
    prefill.origin + prefill.pathname === "https://github.com/PravdeepK/stem-player/issues/new" &&
      prefill.searchParams.get("template") === "bug.yml" &&
      prefill.searchParams.get("title") === TITLE &&
      prefill.searchParams.get("steps") === STEPS &&
      prefill.searchParams.get("system").startsWith("App version:"),
    opened.at(-1).slice(0, 120) + "…"
  );
  check("says it opened GitHub", (await f.text("#fallback-note")).startsWith("Opened GitHub in your browser"));
  await f.shot("feedback-3-failure");

  // A long report gets cut down for the link and copied whole.
  await f.js(`document.getElementById("description").value = "word ".repeat(2000)`);
  clipboard.writeText("");
  await f.click("#open-github");
  check(
    "a long report is cut to fit the link and copied whole",
    opened.at(-1).length <= 8000 && clipboard.readText().length > 10000 && (await f.text("#fallback-note")).includes("cut short"),
    `link ${opened.at(-1).length} chars`
  );

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nscreenshots: ${OUT}`);
  console.log(`${results.length - failed}/${results.length} passed`);
  if (failed) console.log("relay log:\n" + relayLog.join("\n"));
  return failed;
}

run()
  .then((failed) => app.exit(failed ? 1 : 0))
  .catch((err) => {
    console.error("harness error", err);
    console.log("relay log:\n" + relayLog.join("\n"));
    app.exit(1);
  })
  .finally(() => relay && relay.kill());

setTimeout(() => {
  console.error("timeout");
  app.exit(1);
}, 120000);
