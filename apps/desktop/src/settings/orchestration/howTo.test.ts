import { describe, expect, it } from "vitest";
import type { SkillStatus } from "@/api";

type SkillAgent = SkillStatus["agents"][number];
import { translate } from "@/i18n";
import { coverageLine, DEPTH_MAX, HOW_TO, parseDepth, promptText, skillState } from "./howTo";

const agent = (id: string, detected: boolean, ready: boolean): SkillAgent => ({ id, name: id, detected, ready, path: null });
const status = (agents: SkillAgent[], over: Partial<SkillStatus> = {}): SkillStatus => ({ installed: true, edited: false, canonical: "/x", agents, installCommand: "xdev skills install", ...over });

describe("coverageLine", () => {
  it("checking while the status is loading", () => {
    expect(coverageLine(null)).toEqual({ key: "settings.orchestration.coverage.checking", hint: false });
  });
  it("none when no agent CLI is detected", () => {
    expect(coverageLine(status([agent("claude", false, false)])).key).toBe("settings.orchestration.coverage.none");
    expect(coverageLine(status([])).key).toBe("settings.orchestration.coverage.none");
  });
  it("all when every detected agent has the skill; undetected ones do not count", () => {
    const line = coverageLine(status([agent("claude", true, true), agent("codex", true, true), agent("gemini", false, false)]));
    expect(line).toEqual({ key: "settings.orchestration.coverage.all", vars: { count: 2 }, hint: false });
  });
  it("some, with the install hint", () => {
    const line = coverageLine(status([agent("claude", true, true), agent("codex", true, false)]));
    expect(line).toEqual({ key: "settings.orchestration.coverage.some", vars: { ready: 1, total: 2 }, hint: true });
    expect(translate("en", line.key, line.vars)).toBe("1 of 2 detected agents have the skill.");
  });
});

describe("skillState", () => {
  it("maps the status", () => {
    expect(skillState(null)).toBe("notInstalled");
    expect(skillState(status([], { installed: false }))).toBe("notInstalled");
    expect(skillState(status([], { edited: true }))).toBe("edited");
    expect(skillState(status([]))).toBe("installed");
  });
});

describe("parseDepth", () => {
  it("clamps to 1..9", () => {
    expect(parseDepth("0", 3)).toBe(1);
    expect(parseDepth("4", 1)).toBe(4);
    expect(parseDepth("99", 1)).toBe(DEPTH_MAX);
  });
  it("keeps the previous value for text that is not a whole number", () => {
    for (const raw of ["", "abc", "-2", "1.5", "1e2"]) expect(parseDepth(raw, 3), raw).toBe(3);
  });
});

describe("how-to cards", () => {
  it("has five cards, each with a title, summary and prompt in en and vi that names the skill", () => {
    expect(HOW_TO.map((c) => c.id)).toEqual(["handoff", "worktree-handoff", "child-sequence", "child-parallel", "child-worktrees"]);
    for (const c of HOW_TO) for (const locale of ["en", "vi"] as const) {
      for (const part of ["title", "summary", "prompt"]) {
        const key = `settings.orchestration.howTo.${c.id}.${part}`;
        expect(translate(locale, key), `${locale} ${key}`).not.toBe(key);
      }
      expect(translate(locale, `settings.orchestration.howTo.${c.id}.prompt`)).toContain("/xdev-orchestration");
    }
  });
  it("promptText trims", () => {
    expect(promptText("  a b \n")).toBe("a b");
  });
});
