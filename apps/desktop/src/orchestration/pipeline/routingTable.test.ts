import { describe, expect, it } from "vitest";
import { createMockApi } from "@/api";
import { rowMatches } from "@/mockPipeline";
import { BLANK_EDIT, DEFAULT_EDIT, fromRow, keyTarget, move, parseKeywords, savedRouting, tableProblem, targetText, toRow } from "./routingTable";

describe("routingTable", () => {
  it("keywords are comma separated and trimmed", () => {
    expect(parseKeywords(" fix typo , rename,, ")).toEqual(["fix typo", "rename"]);
    expect(parseKeywords("")).toEqual([]);
  });

  it("a row converts both ways and drops blank parts", () => {
    const row = toRow({ keywords: "a, b", label: " big ", agent: " codex ", model: " ", pool: "team" });
    expect(row).toEqual({ keywords: ["a", "b"], label: "big", target: { agent: "codex", pool: "team" } });
    expect(fromRow(row)).toEqual({ keywords: "a, b", label: "big", agent: "codex", model: "", pool: "team" });
    expect(toRow(BLANK_EDIT)).toEqual({ keywords: [], target: { agent: "claude" } });
  });

  it("moves a row and holds it inside the list", () => {
    expect(move(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(move(["a", "b", "c"], 0, 9)).toEqual(["b", "c", "a"]);
    expect(move(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(move(["a"], 5, 0)).toEqual(["a"]);
  });

  it("Alt+Up and Alt+Down move a row one place, and nothing else does", () => {
    expect(keyTarget("ArrowUp", true, 2, 3)).toBe(1);
    expect(keyTarget("ArrowDown", true, 0, 3)).toBe(1);
    expect(keyTarget("ArrowUp", true, 0, 3)).toBeNull();
    expect(keyTarget("ArrowDown", true, 2, 3)).toBeNull();
    expect(keyTarget("ArrowUp", false, 2, 3)).toBeNull();
    expect(keyTarget("Enter", true, 1, 3)).toBeNull();
  });

  it("an old routing saves back as it was; the table and default row are written only when there are any", () => {
    const rules = [{ role: "review", provider: null, maxPrompt: null, model: " haiku " }];
    expect(savedRouting(rules, [], null, false)).toEqual({ rules: [{ ...rules[0], model: "haiku" }] });
    expect(savedRouting(rules, [], null, true).table).toEqual([]);
    const saved = savedRouting(rules, [{ ...BLANK_EDIT, keywords: "x" }], { ...DEFAULT_EDIT, agent: "codex" }, false);
    expect(saved.table).toEqual([{ keywords: ["x"], target: { agent: "claude" } }]);
    expect(saved.fallback).toEqual({ agent: "codex" });
  });

  it("every row needs an agent and a keyword or a label", () => {
    expect(tableProblem([], null)).toBeNull();
    expect(tableProblem([{ ...BLANK_EDIT, keywords: "x" }], DEFAULT_EDIT)).toBeNull();
    expect(tableProblem([{ ...BLANK_EDIT, label: "docs" }], null)).toBeNull();
    expect(tableProblem([{ ...BLANK_EDIT, keywords: "x", agent: " " }], null)).toBe("agent");
    expect(tableProblem([{ ...BLANK_EDIT }], null)).toBe("condition");
    expect(tableProblem([], { ...DEFAULT_EDIT, agent: "" })).toBe("agent");
  });

  it("names a target", () => {
    expect(targetText({ agent: "claude", model: "opus", pool: "team" })).toBe("claude · opus · team");
    expect(targetText({ agent: "codex" })).toBe("codex");
  });

  it("the mock matcher follows the backend's rules: whole words, phrases, labels, first row wins", async () => {
    const row = (keywords: string[], label?: string) => ({ keywords, ...(label ? { label } : {}), target: { agent: "claude" } });
    expect(rowMatches(row(["fix typo"]), "Please FIX   typo.", null)).toBe(true);
    expect(rowMatches(row(["refactor"]), "prefactored", null)).toBe(false);
    expect(rowMatches(row(["fix typo"]), "typo to fix", null)).toBe(false);
    expect(rowMatches(row([], "Docs"), "x", " docs ")).toBe(true);
    expect(rowMatches(row([" "], " "), "x", "")).toBe(false);
    const api = createMockApi({});
    const routing = { rules: [], table: [{ ...row(["a"]), target: { agent: "codex", model: "m" } }, row(["a"])], fallback: { agent: "claude", pool: "p" } };
    expect(await api.routingMatch(routing, "do a thing", null)).toEqual({ row: 0, target: { agent: "codex", model: "m" } });
    expect(await api.routingMatch(routing, "nothing here", null)).toEqual({ row: null, target: { agent: "claude", pool: "p" } });
    expect(await api.routingMatch({ rules: [] }, "x", null)).toEqual({ row: null, target: { agent: "claude" } });
  });
});
