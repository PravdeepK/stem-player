// Separation settings for this Mac. Making stems needs Apple silicon until the
// web version, so the only question is whether its GPU can run Demucs. The one
// measurement behind the GPU default: on an M4, Fast was about 40% quicker on
// the GPU than the CPU, with the same stems.

export const QUALITY = [
  { model: "htdemucs", label: "Fast" },
  { model: "htdemucs_ft", label: "Best" },
];

export const PROCESSORS = [
  { id: "gpu", label: "GPU" },
  { id: "cpu", label: "CPU" },
];

/** "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz" -> "Intel Core i7-9750H". */
export function chipName(raw) {
  if (!raw) return "";
  return raw
    .replace(/\((R|TM)\)/gi, "")
    .replace(/\s+CPU\s+@.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether this Mac can make stems at all. */
export function canSeparate(mac) {
  return mac.appleSilicon;
}

/** @returns {{ model: string, processor: "gpu" | "cpu" }} */
export function recommend(mac) {
  return { model: "htdemucs", processor: mac.gpuSupported ? "gpu" : "cpu" };
}
