import type { PaletteItem } from "@/palette/items";
import { LAYOUT_PRESETS, type LayoutPreset } from "./layoutPresets";

/** What the palette (or a menu) asks of the layout host: a preset for the current worktree or for all, or canvas mode. */
export type LayoutRequest = { kind: "preset"; preset: LayoutPreset; all: boolean } | { kind: "canvas" };

const listeners = new Set<(req: LayoutRequest) => void>();

/** Asks the host to act. Nothing happens when it is not mounted. */
export function requestLayout(req: LayoutRequest): void {
  for (const cb of [...listeners]) cb(req);
}

/** The host listens here. Returns the unsubscribe. */
export function onLayoutRequest(cb: (req: LayoutRequest) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The palette's ways in: "Layout: Grid" and the other presets, canvas mode, and each preset for all projects. */
export function layoutItems(t: T, request: (req: LayoutRequest) => void = requestLayout): PaletteItem[] {
  const keywords = (key: string) => t(`${key}.keywords`).split(/\s+/).filter(Boolean);
  const presets = LAYOUT_PRESETS.map((preset): PaletteItem => ({
    id: `layout:${preset}`,
    kind: "action",
    title: t("layoutPreset.palette.apply", { name: t(`layoutPreset.${preset}`) }),
    keywords: keywords("layoutPreset.palette"),
    run: () => request({ kind: "preset", preset, all: false }),
  }));
  const all = LAYOUT_PRESETS.filter((p) => p !== "fullscreen").map((preset): PaletteItem => ({
    id: `layout:all:${preset}`,
    kind: "action",
    title: t("layoutPreset.palette.all", { name: t(`layoutPreset.${preset}`) }),
    keywords: keywords("layoutPreset.palette"),
    run: () => request({ kind: "preset", preset, all: true }),
  }));
  const canvas: PaletteItem = {
    id: "layout:canvas",
    kind: "action",
    title: t("canvas.palette.toggle"),
    keywords: keywords("canvas.palette"),
    run: () => request({ kind: "canvas" }),
  };
  return [...presets, canvas, ...all];
}
