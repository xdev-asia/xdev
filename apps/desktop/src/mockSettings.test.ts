import { expect, it, vi } from "vitest";
import { createMockApi } from "./api";
import { DIFF_DEFAULTS, NAVIGATION_DEFAULTS, SIDEBAR_PREFS_DEFAULTS } from "./mockSettings";

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

it("starts usage from the defaults and normalises the cache lifetime like a put", async () => {
  const api = createMockApi({});
  const seen = vi.fn();
  api.onSettingsChanged((e) => seen(e.sections));
  expect(await api.usageSettings()).toEqual({
    display: "used",
    footer: { claude: true, codex: true },
    scan: { claude: false, codex: false },
    cacheTimer: false,
    cacheTtlMs: 300_000,
  });
  const stored = await api.usageSettingsPut({ ...(await api.usageSettings()), display: "remaining", cacheTtlMs: 12345 });
  expect(stored).toMatchObject({ display: "remaining", cacheTtlMs: 300_000 });
  expect((await api.usageSettingsPut({ ...stored, cacheTtlMs: 3_600_000 })).cacheTtlMs).toBe(3_600_000);
  expect(seen).toHaveBeenCalledWith(["usage"]);
});

it("the mock usage report follows the scan switches and keeps tracking-since across ranges", async () => {
  const api = createMockApi({});
  const base = { sinceDay: "2026-10-01", untilDay: "2026-10-30", agent: null, scope: "all" as const, refresh: false };
  expect((await api.kitUsageReport(base)).sessions).toBe(0);
  await api.usageSettingsPut({ ...(await api.usageSettings()), scan: { claude: true, codex: false } });
  const claude = await api.kitUsageReport(base);
  expect(claude.by_agent.map(([a]) => a)).toEqual(["claude"]);
  const all = await api.kitUsageReport({ ...base, sinceDay: null });
  expect(all.tracking_since).toBe(claude.tracking_since);
  expect(all.summary.days.length).toBeGreaterThan(claude.summary.days.length);
});

it("carries the sidebar layout through a prefs put", async () => {
  const api = createMockApi({});
  expect(await api.sidebarPrefsGet()).toEqual(SIDEBAR_PREFS_DEFAULTS);
  const next = { ...SIDEBAR_PREFS_DEFAULTS, groupBy: "pr" as const, sort: "recent" as const, compactCards: true, card: { ...SIDEBAR_PREFS_DEFAULTS.card, time: false } };
  expect(await api.sidebarPrefsPut(next)).toEqual(next);
  expect(await api.sidebarPrefsGet()).toEqual(next);
});

it("starts the pull policy at fast-forward only and stores a change", async () => {
  const api = createMockApi({});
  expect((await api.gitSettings()).pullPolicy).toBe("ff-only");
  const stored = await api.setGitSettings({ ...(await api.gitSettings()), pullPolicy: "rebase" });
  expect(stored.pullPolicy).toBe("rebase");
  expect((await api.gitSettings()).pullPolicy).toBe("rebase");
});
