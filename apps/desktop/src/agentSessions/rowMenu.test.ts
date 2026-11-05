import { describe, expect, it, vi } from "vitest";
import type { SessionRow } from "@/api";
import { resumeCommand, rowMenuItems } from "./rowMenu";

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

describe("rowMenuItems", () => {
  const actions = () => ({ handOff: vi.fn(), copyCommand: vi.fn(), jump: vi.fn() });

  it("offers Jump only when the session is open in a tab", () => {
    expect(labels(rowMenuItems(row("claude"), null, t, actions(), true))).toEqual(["agentSessions.menu.handOff", "agentSessions.menu.copyCommand"]);
    expect(labels(rowMenuItems(row("claude"), "tab-1", t, actions(), true))).toEqual(["agentSessions.menu.jump", "agentSessions.menu.handOff", "agentSessions.menu.copyCommand"]);
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
