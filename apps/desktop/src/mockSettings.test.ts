import { expect, it, vi } from "vitest";
import { createMockApi } from "./api";
import { DIFF_DEFAULTS, NAVIGATION_DEFAULTS } from "./mockSettings";

it("starts navigation and diff from the defaults the backend stores", async () => {
  const api = createMockApi({});
  expect(await api.navigationSettings()).toEqual({
    tabOrder: "mru",
    confirmClosePinned: true,
    confirmCloseRunning: true,
    askBeforeDeleteWorktree: true,
  });
  expect(await api.diffSettings()).toEqual({
    defaultView: "inline",
    ignoreWhitespace: false,
    collapseUnchanged: true,
    wordWrap: false,
    fileTree: false,
  });
});

it("returns what a navigation put stored and names the section", async () => {
  const api = createMockApi({});
  const seen = vi.fn();
  api.onSettingsChanged((e) => seen(e.sections));
  const next = { ...NAVIGATION_DEFAULTS, tabOrder: "sequential" as const, confirmClosePinned: false };
  expect(await api.navigationSettingsPut(next)).toEqual(next);
  expect(await api.navigationSettings()).toEqual(next);
  expect(seen).toHaveBeenCalledWith(["navigation"]);
});

it("returns what a diff put stored and names the section", async () => {
  const api = createMockApi({});
  const seen = vi.fn();
  api.onSettingsChanged((e) => seen(e.sections));
  const next = { ...DIFF_DEFAULTS, defaultView: "split" as const, wordWrap: true };
  expect(await api.diffSettingsPut(next)).toEqual(next);
  expect(await api.diffSettings()).toEqual(next);
  expect(seen).toHaveBeenCalledWith(["diff"]);
});
