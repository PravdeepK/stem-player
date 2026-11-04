import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { parseTrackpads } = createRequire(import.meta.url)("../electron/trackpad.js");

// Trimmed from real `ioreg -r -c AppleMultitouchDevice -d 1` output.
function device({ actuation = "Yes", suppressed = "No" } = {}) {
  return [
    "+-o AppleMultitouchDevice  <class AppleMultitouchDevice, id 0x100000bd8, registered, matched, active>",
    "    {",
    '      "Product" = "Apple Internal Keyboard / Trackpad"',
    '      "ForceSupported" = Yes',
    `      "MultitouchPreferences" = {"TrackpadHandResting"=Yes,"ForceSuppressed"=${suppressed},"Clicking"=Yes}`,
    '      "MT Built-In" = Yes',
    `      "ActuationSupported" = ${actuation}`,
    "    }",
    "",
  ].join("\n");
}

test("a Force Touch trackpad with haptic feedback on", () => {
  assert.equal(parseTrackpads(device()), "on");
});

test("Force Click and haptic feedback turned off", () => {
  assert.equal(parseTrackpads(device({ suppressed: "Yes" })), "off");
  assert.equal(parseTrackpads(device({ suppressed: "1" })), "off");
});

test("no trackpad with a Taptic Engine", () => {
  assert.equal(parseTrackpads(""), "none");
  assert.equal(parseTrackpads(device({ actuation: "No" })), "none");
});

test("one trackpad with taps on is enough", () => {
  assert.equal(parseTrackpads(device({ suppressed: "Yes" }) + device()), "on");
  assert.equal(parseTrackpads(device({ actuation: "No" }) + device({ suppressed: "Yes" })), "off");
});
