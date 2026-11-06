import { expect, it } from "vitest";
import { translate } from "@/i18n";
import { draftFromSelection, fenceFor, titleOf } from "./captureTask";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const file = { kind: "file", file: "src/a.ts", from: 3, to: 9 } as const;

it("the title is the first non-empty line, trimmed", () => {
  expect(titleOf("\n  \n   Fix the loop  \nmore")).toBe("Fix the loop");
  expect(titleOf("   ")).toBe("");
});

it("the title is cut at 80 characters", () => {
  expect(titleOf("x".repeat(200))).toHaveLength(80);
  expect(Array.from(titleOf("é".repeat(100)))).toHaveLength(80);
});

it("the fence is longer than any run of backticks in the text", () => {
  expect(fenceFor("plain")).toBe("```");
  expect(fenceFor("a ``` b")).toBe("````");
  expect(fenceFor("`one` and `````five`````")).toBe("``````");
});

it("the body names the source, then fences the text", () => {
  const draft = draftFromSelection({ text: "line one\n```\ncode\n```\n", source: file }, t);
  expect(draft.title).toBe("line one");
  expect(draft.body).toBe("From src/a.ts, lines 3–9\n\n````\nline one\n```\ncode\n```\n````\n");
  const term = draftFromSelection({ text: "npm test\r\nfailed", source: { kind: "terminal", tabTitle: "claude" } }, t);
  expect(term.body).toBe("From terminal claude\n\n```\nnpm test\nfailed\n```\n");
});

it("empty text gives an empty title and only the source line", () => {
  const draft = draftFromSelection({ text: " \n ", source: file }, t);
  expect(draft).toEqual({ title: "", labels: [], body: "From src/a.ts, lines 3–9\n" });
});
