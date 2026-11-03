import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockApi, type StatusSettings } from "@/api";
import { translate } from "@/i18n";
import { STATUS_DEFAULTS } from "@/status/statusSettings";
import { BADGE_DEBOUNCE_MS, COOLDOWN_MS, FOCUS_JUMP_MS, createNotifier } from "./notifier";
import type { Tab } from "./sessions";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const tab = (id: string) => ({ id, worktree: "/demo/wt/xdev-oak", profileId: "claude", status: "needs-you" }) as Tab;
const names = { worktree: "oak", tab: "Claude" };

function setup(over: Partial<StatusSettings> = {}) {
  const api = createMockApi({});
  let settings: StatusSettings = { ...STATUS_DEFAULTS, ...over };
  let clock = 1_000_000;
  const play = vi.fn(async () => true);
  const notify = vi.spyOn(api, "statusNotify");
  const badge = vi.spyOn(api, "statusBadge");
  const notifier = createNotifier({ api, settings: async () => settings, play, now: () => clock, t: en });
  return {
    api, notifier, play, notify, badge,
    set: (next: Partial<StatusSettings>) => void (settings = { ...settings, ...next }),
    advance: (ms: number) => void (clock += ms),
    now: () => clock,
  };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("notifies, sounds and counts when channels are on", async () => {
  const s = setup();
  await s.notifier.attention(tab("a"), "needs-you", names);
  expect(s.notify).toHaveBeenCalledWith("oak", en("status.notify.needs-you", { name: "Claude" }), "a");
  expect(s.api.__notifications.at(-1)?.body).toBe("Claude needs you");
  expect(s.play).toHaveBeenCalledTimes(1);
  expect(s.notifier.lastNotified()).toEqual({ ptyId: "a", at: s.now() });
  s.notifier.badge(1);
  await vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS);
  expect(s.badge).toHaveBeenCalledWith(1);
  expect(s.api.__badge()).toBe(1);
});

it("the body names the tab and the state, never what was typed", async () => {
  const s = setup();
  await s.notifier.attention(tab("a"), "done", { worktree: "oak", tab: "Codex" });
  await s.notifier.attention(tab("a"), "failed", { worktree: "oak", tab: "Codex" });
  expect(s.api.__notifications.map((n) => n.body)).toEqual(["Codex finished", "Codex failed"]);
  expect(translate("vi", "status.notify.done", { name: "Codex" })).toBe("Codex đã xong");
});

it("each channel can be turned off, and follows a change at once", async () => {
  const s = setup({ os: false });
  await s.notifier.attention(tab("a"), "needs-you", names);
  // With the OS channel off the sound still plays on its own.
  expect(s.notify).not.toHaveBeenCalled();
  expect(s.play).toHaveBeenCalledTimes(1);

  s.set({ os: true, sound: false });
  await s.notifier.attention(tab("b"), "needs-you", names);
  expect(s.notify).toHaveBeenCalledTimes(1);
  expect(s.play).toHaveBeenCalledTimes(1);

  s.set({ badge: false });
  s.notifier.badge(3);
  await vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS);
  expect(s.badge.mock.calls.every(([n]) => n === 0)).toBe(true);
  s.set({ badge: true });
  s.notifier.badge(3);
  await vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS);
  expect(s.badge).toHaveBeenLastCalledWith(3);
});

it("a sound goes only with an OS notification that was sent", async () => {
  const s = setup();
  s.notify.mockRejectedValueOnce({ code: "io" });
  await s.notifier.attention(tab("a"), "needs-you", names);
  expect(s.play).not.toHaveBeenCalled();
  expect(s.notifier.lastNotified()).toBeNull();
});

it("one pane and state is told once per cooldown; others are not held back", async () => {
  const s = setup();
  await s.notifier.attention(tab("a"), "needs-you", names);
  s.advance(500);
  await s.notifier.attention(tab("a"), "needs-you", names);
  expect(s.notify).toHaveBeenCalledTimes(1);
  expect(s.play).toHaveBeenCalledTimes(1);
  // Another state of the same pane, or another pane, is its own key.
  await s.notifier.attention(tab("a"), "done", names);
  await s.notifier.attention(tab("b"), "needs-you", names);
  expect(s.notify).toHaveBeenCalledTimes(3);
  s.advance(COOLDOWN_MS);
  await s.notifier.attention(tab("a"), "needs-you", names);
  expect(s.notify).toHaveBeenCalledTimes(4);
});

it("a burst arriving together is told once", async () => {
  const s = setup();
  await Promise.all([1, 2, 3].map(() => s.notifier.attention(tab("a"), "done", names)));
  expect(s.notify).toHaveBeenCalledTimes(1);
  expect(s.play).toHaveBeenCalledTimes(1);
});

it("the badge waits for the count to settle", async () => {
  const s = setup();
  s.notifier.badge(1);
  s.notifier.badge(2);
  await vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS - 1);
  expect(s.badge).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(s.badge.mock.calls).toEqual([[2]]);
  // The same count is not sent again.
  s.notifier.badge(2);
  await vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS);
  expect(s.badge).toHaveBeenCalledTimes(1);
});

it("a focus soon after a notification points at its pane, once", async () => {
  const s = setup();
  await s.notifier.attention(tab("a"), "needs-you", names);
  expect(s.notifier.takeFocusJump(s.now() + 10_000)).toBe("a");
  expect(s.notifier.takeFocusJump(s.now() + 10_000)).toBeNull();

  s.advance(COOLDOWN_MS);
  await s.notifier.attention(tab("a"), "needs-you", names);
  expect(s.notifier.takeFocusJump(s.now() + FOCUS_JUMP_MS + 5000)).toBeNull();

  // A click in the app first means the focus was the person's own.
  s.advance(COOLDOWN_MS);
  await s.notifier.attention(tab("a"), "needs-you", names);
  s.notifier.cancelFocusJump();
  expect(s.notifier.takeFocusJump(s.now() + 1000)).toBeNull();
});
