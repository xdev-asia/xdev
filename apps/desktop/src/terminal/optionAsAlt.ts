import type { MacOptionAsAlt } from "@/api";

export type DetectedLayout = "us" | "other" | "unknown";

export function classifyInputSource(_id: string | null): DetectedLayout {
  throw new Error("not implemented");
}

export function effectiveOptionAsAlt(
  _setting: MacOptionAsAlt,
  _detected: DetectedLayout,
): "both" | "left" | "right" | "off" {
  throw new Error("not implemented");
}

export function startOptionAsAltProbe(
  _read: () => Promise<string | null>,
  _win?: Pick<Window, "addEventListener" | "removeEventListener">,
): () => void {
  throw new Error("not implemented");
}

export function getDetectedLayout(): DetectedLayout {
  return "unknown";
}

export function subscribeDetectedLayout(_cb: () => void): () => void {
  return () => {};
}
