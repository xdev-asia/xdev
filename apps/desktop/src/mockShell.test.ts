import { expect, it, vi } from "vitest";
import type { UpdatePhase } from "./api";
import { createMockShell, SHELL_DEFAULTS } from "./mockShell";

it("starts from the defaults Rust stores and keeps the notice flag on a put", async () => {
  const emit = vi.fn();
  const shell = createMockShell(emit);
  expect(await shell.shellSettings()).toEqual({ minimizeToTray: false, menuBarIcon: true, trayNoticeShown: false, updateChannel: "stable", updateDelayDays: 0 });
  const stored = await shell.shellSettingsPut({ ...SHELL_DEFAULTS, minimizeToTray: true, trayNoticeShown: true });
  expect(stored).toMatchObject({ minimizeToTray: true, trayNoticeShown: false });
  expect(emit).toHaveBeenCalledWith(["shell"]);
});

it("reports up to date when no update is seeded and stores the channel on a shift check", async () => {
  const emit = vi.fn();
  const shell = createMockShell(emit);
  const seen: UpdatePhase[] = [];
  await shell.onUpdatePhase((p) => seen.push(p));
  expect(await shell.updatePhase()).toEqual({ kind: "idle" });
  expect(await shell.updateCheck(false)).toEqual({ kind: "up-to-date" });
  expect(seen.map((p) => p.kind)).toEqual(["checking", "up-to-date"]);
  expect((await shell.shellSettings()).updateChannel).toBe("stable");
  await shell.updateCheck(true);
  expect((await shell.shellSettings()).updateChannel).toBe("rc");
  expect(emit).toHaveBeenCalledWith(["shell"]);
});

it("walks checking, downloading, ready for a seeded version", async () => {
  const shell = createMockShell(() => {}, "0.9.0");
  const seen: UpdatePhase[] = [];
  await shell.onUpdatePhase((p) => seen.push(p));
  expect(await shell.updateCheck(false)).toEqual({ kind: "ready", version: "0.9.0", notes: null });
  expect(seen.map((p) => p.kind)).toEqual(["checking", "downloading", "downloading", "ready"]);
  expect(await shell.updatePhase()).toEqual({ kind: "ready", version: "0.9.0", notes: null });
});

it("records quits, cancels, attention, links and menu actions for the tests", async () => {
  const shell = createMockShell();
  expect(shell.__quitMode()).toBeNull();
  await shell.shellQuit("end-all");
  expect(shell.__quitMode()).toBe("end-all");
  await shell.shellQuitCancelled();
  expect(shell.__quitMode()).toBeNull();
  await shell.trayAttention();
  expect(shell.__attention()).toBe(1);
  await shell.helpOpen("docs");
  await shell.helpOpen("source");
  expect(shell.__opened()).toEqual(["docs", "source"]);
  const got = vi.fn();
  const off = await shell.onMenuAction(got);
  shell.__menu("open-settings");
  off();
  shell.__menu("about");
  expect(got.mock.calls).toEqual([["open-settings"]]);
  expect(await shell.shellCloseRequested("t", "b")).toEqual({ intent: "close", mode: null });
  shell.__closeIntent("hide");
  expect(await shell.shellCloseRequested("t", "b")).toEqual({ intent: "hide", mode: null });
});

it("lists builds for the channel and installs a tag through the phases", async () => {
  const shell = createMockShell();
  const stable = await shell.updateReleases();
  expect(stable.kind === "loaded" && stable.builds.some((b) => b.prerelease)).toBe(false);
  await shell.updateCheck(true);
  const rc = await shell.updateReleases();
  expect(rc.kind === "loaded" && rc.builds.some((b) => b.prerelease)).toBe(true);
  expect(await shell.updateDeferred()).toBeNull();
  expect(await shell.updateInstallTag("v0.2.0")).toEqual({ kind: "ready", version: "0.2.0", notes: null });
});
