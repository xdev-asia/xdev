import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import type { Sessions, Tab } from "@/workspace/sessions";
import { ADOPT_MAX, adoptLoop, ChatSurface, composerKey, submit } from "./ChatSurface";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const t = (key: string) => translate("en", key);
const tab = (over: Partial<Tab> = {}) =>
  ({ id: "t1", worktree: "/w", cli: "claude", status: "idle", agentSession: "s1", resumeOf: null, openedAt: 0, account: null, accountSource: null, view: "chat", ...over }) as unknown as Tab;
const api = { agentConversation: async () => ({}), fileLinksResolve: async () => [], openUrl: async () => {}, agentSessions: async () => [] } as never;
const render = (over: Partial<Tab> = {}, now?: number) => renderToStaticMarkup(<ChatSurface api={api} sessions={{} as Sessions} tab={tab(over)} agentName="Claude" now={now} />);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

it("shows Starting and an enabled composer before the session is known", () => {
  const out = render({ agentSession: null });
  expect(out).toContain("Starting Claude");
  expect(out).toContain("<textarea");
  expect(out).not.toMatch(/<textarea[^>]*disabled/);
});

it("with a session renders the tab-mode view and one primary button", () => {
  const out = render();
  expect(out).toContain('data-testid="chat-surface"');
  expect(out).toContain('data-mode="tab"');
  expect(count(out, /class="btn"/g)).toBe(1);
  expect(out).toContain(">Send<");
});

it("an exited tab disables the composer", () => {
  expect(render({ exitCode: 0 }, 1_000_000)).toMatch(/<textarea[^>]*disabled/);
});

it("a failed resume replaces the composer with one primary and one secondary", () => {
  const out = render({ resumeOf: "s0", exitCode: 1 }, 5_000);
  expect(out).toContain("Could not resume the last conversation");
  expect(out).toContain("Start a new conversation");
  expect(out).not.toContain("<textarea");
  expect(count(out, /class="btn"/g)).toBe(1);
  expect(out).toContain("Show terminal");
});

it("submit ignores a blank draft, sends text, and reports the result", async () => {
  const send = vi.fn(async () => "sent" as const);
  expect(await submit("  \n", { id: "t1", send, t })).toMatchObject({ sent: false });
  expect(send).not.toHaveBeenCalled();
  expect(await submit("hi", { id: "t1", send, t })).toEqual({ sent: true, clear: true, note: "" });
  expect(send).toHaveBeenCalledWith("t1", "hi");
  const un = await submit("hi", { id: "t1", send: async () => "unconfirmed", t });
  expect(un).toEqual({ sent: true, clear: true, note: "Sent, but the agent has not answered yet" });
  const bad = await submit("hi", { id: "t1", send: async () => "failed", t });
  expect(bad).toEqual({ sent: true, clear: false, note: "Could not send the message" });
});

it("composerKey sends on Enter only, not with Shift or during IME composition", () => {
  expect(composerKey({ key: "Enter", shiftKey: false })).toBe(true);
  expect(composerKey({ key: "Enter", shiftKey: true })).toBe(false);
  expect(composerKey({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true } })).toBe(false);
  expect(composerKey({ key: "a", shiftKey: false })).toBe(false);
});

it("adoptLoop adopts a found session, and stops after the cap", async () => {
  const stop = vi.fn();
  let fire = () => {};
  const every = (fn: () => void) => {
    fire = fn;
    return stop;
  };
  const adopt = vi.fn();
  const look = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("s9");
  const n = { n: 0 };
  adoptLoop({ look, adopt, count: n, every });
  await vi.waitFor(() => expect(look).toHaveBeenCalledTimes(1), { timeout: 2000 });
  fire();
  await vi.waitFor(() => expect(adopt).toHaveBeenCalledWith("s9"), { timeout: 2000 });
  expect(stop).toHaveBeenCalled();

  const never = vi.fn(async () => null);
  const used = { n: ADOPT_MAX };
  adoptLoop({ look: never, adopt, count: used, every });
  await Promise.resolve();
  expect(never).not.toHaveBeenCalled();
});
