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
  expect(s.notify).toHaveBeenCalledWith("oak · Claude · Needs you", "", "a");
  expect(s.play).toHaveBeenCalledTimes(1);
  expect(s.notifier.lastNotified()).toEqual({ ptyId: "a", at: s.now() });
  s.notifier.badge(1);
  await vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS);
  expect(s.badge).toHaveBeenCalledWith(1);
  expect(s.api.__badge()).toBe(1);
});

it("the title names worktree, tab and state; the body is what the hook said", async () => {
  const s = setup();
  const said = { toolName: "Bash", message: "Run rm -rf build?", isInterrupt: false, error: null };
  await s.notifier.attention(tab("a"), "needs-you", names, said);
  // No message: the tool name. No detail at all: an empty body.
  await s.notifier.attention(tab("b"), "needs-you", names, { ...said, message: null });
  await s.notifier.attention(tab("c"), "done", { worktree: "oak", tab: "Codex" });
  await s.notifier.attention(tab("d"), "failed", names, { toolName: null, message: null, isInterrupt: false, error: "rate limit" });
  expect(s.api.__notifications.map((n) => [n.title, n.body])).toEqual([
    ["oak · Claude · Needs you", "Run rm -rf build?"],
    ["oak · Claude · Needs you", "Bash"],
    ["oak · Codex · Done", ""],
    ["oak · Claude · Failed", "rate limit"],
  ]);
  expect(translate("vi", "status.word.done")).toBe("Đã xong");
});

it("title and body are cut at 40, 80 and 180 and never hold more than the hook gave", async () => {
  const s = setup();
  const long = "x".repeat(300);
  await s.notifier.attention(tab("a"), "needs-you", { worktree: "w".repeat(100), tab: "T".repeat(100) }, { toolName: null, message: `${long} second`, isInterrupt: false, error: null });
  const sent = s.api.__notifications[0];
  expect(sent.title.length).toBeLessThanOrEqual(80);
  expect(sent.title.startsWith(`${"w".repeat(39)}…`)).toBe(true);
  expect(sent.body.length).toBe(180);
  expect(sent.body.endsWith("…")).toBe(true);
  expect(sent.body).not.toContain(" second");
  // Line breaks and runs of spaces fold into single spaces.
  await s.notifier.attention(tab("b"), "done", names, { toolName: null, message: "one\ntwo  \r\n three", isInterrupt: false, error: null });
  expect(s.api.__notifications[1].body).toBe("one two three");
});

it("the master switch and the event switch gate every channel", async () => {
  const s = setup({ onDone: false });
  await s.notifier.attention(tab("a"), "done", names);
  await s.notifier.attention(tab("b"), "bell", names);
  expect(s.notify).not.toHaveBeenCalled();
  expect(s.play).not.toHaveBeenCalled();
  await s.notifier.attention(tab("c"), "needs-you", names);
  expect(s.notify).toHaveBeenCalledTimes(1);
  s.set({ onBell: true });
  await s.notifier.attention(tab("b"), "bell", names);
  expect(s.api.__notifications.at(-1)?.title).toBe("oak · Claude · Bell");
  s.set({ enabled: false });
  await s.notifier.attention(tab("d"), "failed", names);
  await s.notifier.attention(tab("e"), "needs-you", names);
  expect(s.notify).toHaveBeenCalledTimes(2);
  expect(s.play).toHaveBeenCalledTimes(2);
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

it("lights the tray once per burst when the event is on", async () => {
  const s = setup();
  const lit = vi.spyOn(s.api, "trayAttention");
  await Promise.all([s.notifier.attention(tab("a"), "needs-you", names), s.notifier.attention(tab("a"), "needs-you", names)]);
  expect(lit).toHaveBeenCalledTimes(1);
  s.advance(COOLDOWN_MS);
  await s.notifier.attention(tab("a"), "needs-you", names);
  expect(lit).toHaveBeenCalledTimes(2);
});

it("does not light the tray when the master switch or the event is off", async () => {
  const off = setup({ enabled: false });
  const lit = vi.spyOn(off.api, "trayAttention");
  await off.notifier.attention(tab("a"), "needs-you", names);
  expect(lit).not.toHaveBeenCalled();
  const quiet = setup({ onNeedsInput: false });
  const litQuiet = vi.spyOn(quiet.api, "trayAttention");
  await quiet.notifier.attention(tab("a"), "needs-you", names);
  expect(litQuiet).not.toHaveBeenCalled();
});

it("a failing tray call never stops the OS notification", async () => {
  const s = setup();
  vi.spyOn(s.api, "trayAttention").mockRejectedValue(new Error("no tray"));
  await s.notifier.attention(tab("a"), "needs-you", names);
  expect(s.notify).toHaveBeenCalledTimes(1);
});
