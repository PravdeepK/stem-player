"use strict";

// Whether trackpad taps can be felt on this Mac. Each trackpad's registry entry
// says if it has a Taptic Engine (ActuationSupported) and carries the user's
// live trackpad preferences, where ForceSuppressed means "Force Click and
// haptic feedback" is off in System Settings › Trackpad. With that off, every
// app's haptics are silently dropped.

const { spawnSync } = require("child_process");

const SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.trackpad";

/**
 * `ioreg -r -c AppleMultitouchDevice -d 1` output -> "on" | "off" | "none".
 * "none" means no trackpad here has a Taptic Engine (a mouse, or an older
 * Magic Trackpad). Any one trackpad with taps on is enough.
 */
function parseTrackpads(ioreg) {
  const devices = String(ioreg)
    .split(/^\+-o /m)
    .filter((block) => /"ActuationSupported"\s*=\s*Yes/.test(block));
  if (devices.length === 0) return "none";
  const on = devices.some((block) => !/"ForceSuppressed"\s*=\s*(Yes|1)\b/.test(block));
  return on ? "on" : "off";
}

/** This Mac's trackpad taps, or "unknown" if the registry can't be read. */
function trackpadHaptics() {
  const out = spawnSync("ioreg", ["-r", "-c", "AppleMultitouchDevice", "-d", "1"], { encoding: "utf8" });
  return out.status === 0 ? parseTrackpads(out.stdout) : "unknown";
}

module.exports = { SETTINGS_URL, parseTrackpads, trackpadHaptics };
