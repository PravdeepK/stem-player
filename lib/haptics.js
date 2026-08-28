// Renderer-side haptics helper.
//
// Every call is a no-op unless the native addon loaded in the main process AND
// the user is on a Force Touch trackpad with a hand on it. That's expected —
// callers should never branch on whether a tap actually happened.

function fire(pattern) {
  const api = typeof window !== "undefined" ? window.api : null;
  if (!api || typeof api.haptic !== "function") return;
  try {
    api.haptic(pattern);
  } catch {
    /* haptics are decoration; never let one break an interaction */
  }
}

/** A button-press tap — mute / solo. */
export function tap() {
  fire("generic");
}

/** A detent tap — a control arriving at the end of its range. */
export function detent() {
  fire("level");
}

/**
 * Fire a detent only when `next` *arrives* at 0 or 1 from somewhere else, so
 * holding a slider against its endpoint taps once rather than every event.
 */
export function detentOnEndpoint(prev, next) {
  const atEnd = next <= 0 || next >= 1;
  const wasAtEnd = prev <= 0 || prev >= 1;
  if (atEnd && !wasAtEnd) detent();
}
