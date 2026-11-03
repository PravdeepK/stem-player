import { test } from "node:test";
import assert from "node:assert/strict";
import { canSeparate, chipName, recommend } from "../lib/recommend.js";

test("only Apple silicon can make stems", () => {
  assert.equal(canSeparate({ appleSilicon: true }), true);
  assert.equal(canSeparate({ appleSilicon: false }), false);
});

test("the GPU is recommended wherever it can run Demucs", () => {
  assert.deepEqual(recommend({ appleSilicon: true, gpuSupported: true }), { model: "htdemucs", processor: "gpu" });
  assert.deepEqual(recommend({ appleSilicon: true, gpuSupported: false }), { model: "htdemucs", processor: "cpu" });
});

test("chip names are cleaned up for display", () => {
  assert.equal(chipName("Apple M4"), "Apple M4");
  assert.equal(chipName("Apple M3 Pro"), "Apple M3 Pro");
  assert.equal(chipName("Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz"), "Intel Core i7-9750H");
  assert.equal(chipName(""), "");
});
