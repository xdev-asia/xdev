import { describe, expect, it, vi } from "vitest";
import type { SessionRow } from "@/api";
import { lastUserPrompt, resumeCommand, rowMenuItems } from "./rowMenu";

const row = (agent: string, id = "4f1c-9_ab"): SessionRow =>
  ({ session: { key: `h:${id}`, id, homeId: "local", agent, cwd: "/a", branch: null, title: "t", model: null, first: 0, last: 0, messages: 1 }, worktree: "/a", repo: "/a", resumable: true }) as unknown as SessionRow;

const t = (key: string) => key;
const labels = (items: ReturnType<typeof rowMenuItems>) => items.map((i) => ("label" in i ? i.label : i.type));

describe("resumeCommand", () => {
  it("is the CLI's own resume form per agent", () => {
    expect(resumeCommand(row("claude"))).toBe("claude --resume 4f1c-9_ab");
    expect(resumeCommand(row("codex", "0199a-b"))).toBe("codex resume 0199a-b");
  });

  it("has none for an unknown agent or an id that would need quoting", () => {
    expect(resumeCommand(row("other"))).toBeNull();
    expect(resumeCommand(row("claude", "a b; rm -rf"))).toBeNull();
  });
});

describe("lastUserPrompt", () => {
  const turn = (role: "user" | "assistant", text: string) => ({ role, text, at: 0 });
  it("is the text of the last user turn, trimmed", () => {
    expect(lastUserPrompt([turn("user", "first"), turn("assistant", "ok"), turn("user", "  second \n"), turn("assistant", "done")])).toBe("second");
  });
  it("is null with no user turn or a blank one", () => {
    expect(lastUserPrompt([])).toBeNull();
    expect(lastUserPrompt([turn("assistant", "hi")])).toBeNull();
    expect(lastUserPrompt([turn("user", "a"), turn("user", "  ")])).toBeNull();
  });
});

describe("rowMenuItems", () => {
  const actions = () => ({ handOff: vi.fn(), copyCommand: vi.fn(), jump: vi.fn() });

  it("offers Jump only when the session is open in a tab", () => {
    expect(labels(rowMenuItems(row("claude"), null, t, actions(), true))).toEqual(["agentSessions.menu.handOff", "agentSessions.menu.copyCommand"]);
    expect(labels(rowMenuItems(row("claude"), "tab-1", t, actions(), true))).toEqual(["agentSessions.menu.jump", "agentSessions.menu.handOff", "agentSessions.menu.copyCommand"]);
  });

  it("puts Copy recent prompt after Copy first prompt, only when given", () => {
    const copyFirstPrompt = vi.fn();
    const copyRecentPrompt = vi.fn();
    const items = rowMenuItems(row("claude"), null, t, { ...actions(), copyFirstPrompt, copyRecentPrompt }, true);
    expect(labels(items)).toEqual(["agentSessions.menu.handOff", "agentSessions.menu.copyCommand", "agentSessions.menu.copyFirstPrompt", "agentSessions.menu.copyRecentPrompt"]);
    const recent = items.find((i) => "label" in i && i.label === "agentSessions.menu.copyRecentPrompt");
    if (recent && "onSelect" in recent) recent.onSelect?.();
    expect(copyRecentPrompt).toHaveBeenCalledTimes(1);
    expect(labels(rowMenuItems(row("claude"), null, t, { ...actions(), copyFirstPrompt }, true))).not.toContain("agentSessions.menu.copyRecentPrompt");
  });

  it("hides Copy resume command when the agent has none, and disables Hand off without a target", () => {
    const items = rowMenuItems(row("other"), null, t, actions(), false);
    expect(labels(items)).toEqual(["agentSessions.menu.handOff"]);
    expect(items[0]).toMatchObject({ disabled: true });
  });

  it("runs the actions with the command text", () => {
    const a = actions();
    const items = rowMenuItems(row("claude"), "tab-1", t, a, true);
    for (const it of items) if (it.type !== "separator" && it.type !== "group") it.onSelect?.();
    expect(a.jump).toHaveBeenCalledOnce();
    expect(a.handOff).toHaveBeenCalledOnce();
    expect(a.copyCommand).toHaveBeenCalledWith("claude --resume 4f1c-9_ab");
  });

  it("offers Copy first prompt only with a title and a handler", () => {
    const withPrompt = { ...actions(), copyFirstPrompt: vi.fn() };
    const items = rowMenuItems(row("claude"), null, t, withPrompt, true);
    expect(labels(items)).toContain("agentSessions.menu.copyFirstPrompt");
    for (const it of items) if (it.type !== "separator" && it.type !== "group") it.onSelect?.();
    expect(withPrompt.copyFirstPrompt).toHaveBeenCalledWith("t");
    const empty = { ...row("claude"), session: { ...row("claude").session, title: "  " } } as SessionRow;
    expect(labels(rowMenuItems(empty, null, t, withPrompt, true))).not.toContain("agentSessions.menu.copyFirstPrompt");
    expect(labels(rowMenuItems(row("claude"), null, t, actions(), true))).not.toContain("agentSessions.menu.copyFirstPrompt");
  });
});

describe("rowMenuItems log actions", () => {
  const base = () => ({ handOff: vi.fn(), copyCommand: vi.fn(), jump: vi.fn() });

  it("shows copy log path, reveal and delete only when their handlers are given", () => {
    expect(labels(rowMenuItems(row("claude"), null, t, base(), true))).not.toContain("agentSessions.menu.delete");
    const a = { ...base(), copyLogPath: vi.fn(), revealLog: vi.fn(), deleteSession: vi.fn() };
    const items = rowMenuItems(row("claude"), null, t, a, true);
    expect(labels(items)).toEqual([
      "agentSessions.menu.handOff",
      "agentSessions.menu.copyCommand",
      "agentSessions.menu.copyLogPath",
      "agentSessions.menu.revealLog",
      "separator",
      "agentSessions.menu.delete",
    ]);
    const only = rowMenuItems(row("claude"), null, t, { ...base(), revealLog: vi.fn() }, true);
    expect(labels(only)).toContain("agentSessions.menu.revealLog");
    expect(labels(only)).not.toContain("agentSessions.menu.copyLogPath");
  });

  it("runs each handler and marks delete as dangerous", () => {
    const a = { ...base(), copyLogPath: vi.fn(), revealLog: vi.fn(), deleteSession: vi.fn() };
    const items = rowMenuItems(row("claude"), null, t, a, true);
    for (const it of items) if (it.type !== "separator" && it.type !== "group") it.onSelect?.();
    expect(a.copyLogPath).toHaveBeenCalledTimes(1);
    expect(a.revealLog).toHaveBeenCalledTimes(1);
    expect(a.deleteSession).toHaveBeenCalledTimes(1);
    expect(items.find((i) => "label" in i && i.label === "agentSessions.menu.delete")).toMatchObject({ danger: true });
  });
});
