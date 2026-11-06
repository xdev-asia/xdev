import { expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { layoutItems, onLayoutRequest, requestLayout, type LayoutRequest } from "./layoutEvents";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

it("palette: a Layout command for each preset, canvas, and each preset for all projects", () => {
  const items = layoutItems(t, () => {});
  const titles = items.map((i) => i.title);
  for (const name of ["Grid", "Columns", "Rows", "Focus", "Fullscreen"]) expect(titles).toContain(`Layout: ${name}`);
  expect(titles).toContain("Layout: Grid in all projects");
  expect(titles).not.toContain("Layout: Fullscreen in all projects");
  expect(items.some((i) => i.id === "layout:canvas")).toBe(true);
  expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  expect(items.every((i) => i.keywords && i.keywords.length > 0)).toBe(true);
});

it("palette: running a command makes the matching request", () => {
  const seen: LayoutRequest[] = [];
  const items = layoutItems(t, (r) => seen.push(r));
  items.find((i) => i.id === "layout:grid")!.run();
  items.find((i) => i.id === "layout:all:rows")!.run();
  items.find((i) => i.id === "layout:canvas")!.run();
  expect(seen).toEqual([
    { kind: "preset", preset: "grid", all: false },
    { kind: "preset", preset: "rows", all: true },
    { kind: "canvas" },
  ]);
});

it("requests reach the host and stop after it unsubscribes", () => {
  const cb = vi.fn();
  const off = onLayoutRequest(cb);
  requestLayout({ kind: "canvas" });
  off();
  requestLayout({ kind: "canvas" });
  expect(cb).toHaveBeenCalledTimes(1);
});
