"use strict";

// Run the relay locally: `node feedback-relay/dev-server.js` serves
// POST http://127.0.0.1:8787/api/feedback with the same env vars as Vercel.
// Point GITHUB_API_URL at a mock to test without touching GitHub.
const http = require("http");
const { createRelay, nodeHandler } = require("./lib/relay");

// PORT=0 picks any free port; the URL it prints is the one to use.
const port = process.env.PORT !== undefined ? Number(process.env.PORT) : 8787;
const handle = nodeHandler(createRelay());

const server = http.createServer((req, res) => {
  if (req.url.split("?")[0] !== "/api/feedback") {
    res.statusCode = 404;
    res.end();
    return;
  }
  handle(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`feedback relay listening on http://127.0.0.1:${server.address().port}/api/feedback`);
});
