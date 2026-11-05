import { expect, it, vi } from "vitest";
import type { MenuAction } from "@/api";
import { ZOOM_STEP } from "@/ui/zoom";
import { runMenuAction, type MenuHandlers } from "./menuActions";

function handlers(): MenuHandlers {
  return {
    openSettings: vi.fn(),
    openShortcuts: vi.fn(),
    openUpdates: vi.fn(),
    confirmQuitEndAll: vi.fn(),
    zoom: vi.fn(),
    toggleLeftSidebar: vi.fn(),
    toggleRightSidebar: vi.fn(),
    openAbout: vi.fn(),
  };
}

it("routes each action to its handler", () => {
  const cases: [MenuAction, keyof MenuHandlers, unknown[]][] = [
    ["open-settings", "openSettings", []],
    ["shortcuts", "openShortcuts", []],
    ["check-updates", "openUpdates", []],
    ["quit-end-all", "confirmQuitEndAll", []],
    ["zoom-in", "zoom", [ZOOM_STEP]],
    ["zoom-out", "zoom", [-ZOOM_STEP]],
    ["zoom-reset", "zoom", [0]],
    ["toggle-left-sidebar", "toggleLeftSidebar", []],
    ["toggle-right-sidebar", "toggleRightSidebar", []],
    ["about", "openAbout", []],
  ];
  for (const [action, name, args] of cases) {
    const h = handlers();
    runMenuAction(action, h);
    expect(h[name], action).toHaveBeenCalledWith(...args);
    const others = (Object.keys(h) as (keyof MenuHandlers)[]).filter((k) => k !== name);
    for (const k of others) expect(h[k], `${action} -> ${k}`).not.toHaveBeenCalled();
  }
});
