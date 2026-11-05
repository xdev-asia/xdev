import { describe, expect, it } from "vitest";
import { AUTO_ORDER, BLANK, MAX_QUERY, matchAgents, pickAgent, scoreAgent, type AgentEntry } from "./agentPick";

const entry = (id: string, label: string, command = id): AgentEntry => ({ id, label, command });

describe("scoreAgent", () => {
  it("ranks label exact, prefix, substring, acronym, then id, then command", () => {
    const q = "gc";
    expect(scoreAgent(q, entry("x1", "gc"))).toBeLessThan(scoreAgent(q, entry("x2", "gcode"))!);
    expect(scoreAgent(q, entry("x2", "gcode"))).toBeLessThan(scoreAgent(q, entry("x3", "big cat gcx"))!);
    expect(scoreAgent(q, entry("x3", "big cat gcx"))).toBeLessThan(scoreAgent(q, entry("x4", "Gemini CLI"))!);
    expect(scoreAgent(q, entry("x4", "Gemini CLI"))).toBeLessThan(scoreAgent(q, entry("gc-id", "Other", "zz"))!);
    expect(scoreAgent(q, entry("gc-id", "Other", "zz"))).toBeLessThan(scoreAgent(q, entry("y", "Other", "gcmd"))!);
    expect(scoreAgent(q, entry("y", "Other", "zz"))).toBeNull();
  });

  it("ignores case and surrounding space; an empty query matches everything", () => {
    expect(scoreAgent("  CLAUDE ", entry("claude", "Claude Code"))).not.toBeNull();
    expect(scoreAgent("", entry("claude", "Claude Code"))).toBe(0);
  });

  it("caps the query at 2048 characters", () => {
    const long = "c".repeat(MAX_QUERY + 500);
    expect(scoreAgent(long, entry("c", "c".repeat(MAX_QUERY)))).toBe(scoreAgent("c".repeat(MAX_QUERY), entry("c", "c".repeat(MAX_QUERY))));
  });
});

describe("matchAgents", () => {
  const list = [entry("claude", "Claude Code"), entry("codex", "Codex"), entry("cursor", "Cursor", "cursor-agent")];

  it("puts the blank terminal first and keeps the order on ties", () => {
    expect(matchAgents("", list, "Blank Terminal").map((e) => e.id)).toEqual([BLANK, "claude", "codex", "cursor"]);
    expect(matchAgents("c", list, "Blank Terminal").map((e) => e.id)).toEqual(["claude", "codex", "cursor"]);
  });

  it("finds the blank terminal by terminal and shell", () => {
    expect(matchAgents("shell", list, "Blank Terminal").map((e) => e.id)).toEqual([BLANK]);
    expect(matchAgents("termi", list, "Blank Terminal").map((e) => e.id)).toEqual([BLANK]);
  });

  it("matches a command when nothing else does", () => {
    expect(matchAgents("cursor-agent", list, "Blank Terminal").map((e) => e.id)).toEqual(["cursor"]);
  });
});

describe("pickAgent", () => {
  it("auto takes the first usable agent in the auto order", () => {
    expect(pickAgent("auto", (id) => id === "aider" || id === "gemini")).toBe("gemini");
    expect(AUTO_ORDER[0]).toBe("claude");
  });

  it("a saved agent wins when usable, else null; blank and nothing usable give null", () => {
    expect(pickAgent("devin", (id) => id === "devin" || id === "claude")).toBe("devin");
    // A saved agent that is missing is a shell, never another agent.
    expect(pickAgent("devin", (id) => id === "codex")).toBeNull();
    expect(pickAgent("blank", () => true)).toBeNull();
    expect(pickAgent("auto", () => false)).toBeNull();
  });
});
