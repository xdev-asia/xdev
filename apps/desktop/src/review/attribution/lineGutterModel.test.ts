import { expect, it } from "vitest";
import type { LineAttribution, LineAuthor } from "@/api";
import { translate } from "@/i18n";
import { when } from "./attributionModel";
import { applicable, authorNames, chipLetter, countLines, legendOf, markerSpec, ownerAt, tooltipOf } from "./lineGutterModel";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const agent = (tabId: string, name: string, at: number): LineAuthor => ({ kind: "agent", tabId, agent: name, at });
const OUT: LineAuthor = { kind: "outside", tabId: null, agent: null, at: null };

const attr: LineAttribution = {
  lines: 6,
  authors: [agent("tab-ab12", "claude", 1000), agent("tab-cd34", "claude", 2000), OUT],
  runs: [
    { from: 2, to: 3, author: 0 },
    { from: 4, to: 4, author: 2 },
    { from: 6, to: 6, author: 1 },
  ],
};

it("counts lines like CodeMirror and the backend", () => {
  expect(countLines("a\r\nb\n")).toBe(3);
  expect(countLines("")).toBe(1);
  expect(countLines("a\rb")).toBe(2);
});

it("runs apply only to a text with the same line count, and never when empty", () => {
  expect(applicable(attr, "1\n2\n3\n4\n5\n6")).toBe(true);
  expect(applicable(attr, "1\r\n2\r\n3\r\n4\r\n5\r\n6")).toBe(true);
  expect(applicable(attr, "1\n2\n3\n4\n5\n6\n")).toBe(false);
  expect(applicable({ lines: 0, authors: [], runs: [] }, "")).toBe(false);
  expect(applicable(null, "a")).toBe(false);
});

it("maps each run line to its author", () => {
  expect([...ownerAt(attr)]).toEqual([
    [2, 0],
    [3, 0],
    [4, 2],
    [6, 1],
  ]);
});

it("a marker is the agent's chip, or the outside ring", () => {
  expect(markerSpec({ kind: "agent", agent: "claude" })).toEqual({ kind: "agent", profile: "claude", letter: undefined });
  expect(markerSpec({ kind: "agent", agent: "aider" })).toEqual({ kind: "agent", profile: "custom", letter: "A" });
  expect(markerSpec({ kind: "agent", agent: "goose" })).toEqual({ kind: "agent", profile: "custom", letter: "G" });
  expect(markerSpec(OUT)).toEqual({ kind: "outside" });
  expect(chipLetter({ kind: "agent", profile: "codex", letter: undefined })).toBe("X");
  expect(chipLetter({ kind: "agent", profile: "claude", letter: undefined })).toBe("C");
});

it("the tooltip names the agent, with the tab suffix when two tabs share it, and the time", () => {
  expect(authorNames(attr, "Unknown")).toEqual(["claude ab12", "claude cd34", ""]);
  expect(tooltipOf(attr, 0, t)).toBe(`claude ab12 wrote this line, ${when(1000)}`);
  expect(tooltipOf(attr, 2, t)).toBe("You or another tool changed this line");
});

it("two versions of one tab are one name and one legend entry, outside last", () => {
  const one: LineAttribution = {
    lines: 4,
    authors: [agent("t1", "claude", 1), OUT, agent("t1", "claude", 2)],
    runs: [
      { from: 1, to: 1, author: 0 },
      { from: 2, to: 2, author: 1 },
      { from: 3, to: 3, author: 2 },
    ],
  };
  expect(authorNames(one, "Unknown")).toEqual(["claude", "", "claude"]);
  expect(legendOf(one, t)).toEqual([
    { key: "t1", spec: { kind: "agent", profile: "claude", letter: undefined }, name: "claude" },
    { key: "outside", spec: { kind: "outside" }, name: "You" },
  ]);
  expect(legendOf(attr, t).map((e) => e.name)).toEqual(["claude ab12", "claude cd34", "You"]);
  expect(legendOf({ ...attr, runs: [] }, t)).toEqual([]);
  expect(legendOf(null, t)).toEqual([]);
});
