import type { Api } from "@/api";

export const ZOOM_STEP = 0.1;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;

let level = 1;

/** Rounds to one decimal and keeps the level inside the range the backend stores. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)) * 10) / 10;
}

function apply(z: number): void {
  level = z;
  if (typeof document !== "undefined" && document.documentElement) document.documentElement.style.zoom = String(z);
}

export function getZoom(): number {
  return level;
}

/** Reads the stored zoom and applies it; a failed read leaves the window at 100%. */
export async function loadZoom(api: Pick<Api, "uiSettingsGet">): Promise<void> {
  const s = await api.uiSettingsGet().catch(() => null);
  if (s) apply(clampZoom(s.zoom));
}

/** `delta` of 0 resets to 100%. Applies at once, then stores; the store's answer is the truth. */
export async function stepZoom(api: Pick<Api, "uiSettingsPut">, delta: number): Promise<number> {
  const next = delta === 0 ? 1 : clampZoom(level + delta);
  apply(next);
  const saved = await api.uiSettingsPut({ zoom: next }).catch(() => null);
  if (saved) apply(clampZoom(saved.zoom));
  return level;
}

/** Tests only. */
export function resetZoomForTests(): void {
  level = 1;
}
