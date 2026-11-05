import type { MacOptionAsAlt } from "@/api";

export type DetectedLayout = "us" | "other" | "unknown";

/** Input sources where Option has nothing to type, so it is safe to use as Alt. */
const US_SOURCES = new Set(["com.apple.keylayout.us", "com.apple.keylayout.abc"]);

export function classifyInputSource(id: string | null): DetectedLayout {
  if (!id) return "unknown";
  return US_SOURCES.has(id.toLowerCase()) ? "us" : "other";
}

/** `auto` follows the detected layout (Alt on US / ABC, composing otherwise or when unknown). */
export function effectiveOptionAsAlt(
  setting: MacOptionAsAlt,
  detected: DetectedLayout,
): "both" | "left" | "right" | "off" {
  if (setting === "auto") return detected === "us" ? "both" : "off";
  return setting;
}

let detected: DetectedLayout = "unknown";
const listeners = new Set<() => void>();

function setDetected(next: DetectedLayout): void {
  if (next === detected) return;
  detected = next;
  for (const cb of [...listeners]) cb();
}

/**
 * Reads the input source now and on every window focus (a layout switched while the window has
 * focus is seen on the next focus). Returns the stop.
 */
export function startOptionAsAltProbe(
  read: () => Promise<string | null>,
  win: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  let stopped = false;
  let seq = 0;
  const probe = () => {
    const mine = ++seq;
    read().then(
      (id) => {
        if (!stopped && mine === seq) setDetected(classifyInputSource(id));
      },
      () => {
        if (!stopped && mine === seq) setDetected("unknown");
      },
    );
  };
  win.addEventListener("focus", probe);
  probe();
  return () => {
    stopped = true;
    win.removeEventListener("focus", probe);
  };
}

export function getDetectedLayout(): DetectedLayout {
  return detected;
}

export function subscribeDetectedLayout(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

export function resetDetectedLayoutForTests(): void {
  detected = "unknown";
  listeners.clear();
}
