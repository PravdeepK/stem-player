"use strict";

// The Vercel function: POST /api/feedback. Vercel sets x-real-ip and
// x-forwarded-for itself, so the rate limit can trust them here.
const { createRelay, nodeHandler } = require("../lib/relay");

module.exports = nodeHandler(createRelay(), { trustProxy: true });
