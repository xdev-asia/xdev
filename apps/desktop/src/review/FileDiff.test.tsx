import { expect, it } from "vitest";
import type { LineAttribution, WorktreeFileDiff } from "@/api";
import { applicable as fromModel } from "./attribution/lineGutterModel";
import { applicable, keepSame } from "./FileDiff";

const diff = (old: string, next: string, skip: WorktreeFileDiff["skip"] = null): WorktreeFileDiff => ({ old, new: next, skip }) as WorktreeFileDiff;

it("a reload with the same text keeps the same diff object, so the editors stay", () => {
  const first = diff("a", "b");
  expect(keepSame(first, diff("a", "b"))).toBe(first);
  const changed = diff("a", "c");
  expect(keepSame(first, changed)).toBe(changed);
  expect(keepSame(null, first)).toBe(first);
  const skipped = diff("a", "b", "binary");
  expect(keepSame(first, skipped)).toBe(skipped);
});

it("line authors apply only when they fit the shown text, CRLF counted as CodeMirror does", () => {
  expect(applicable).toBe(fromModel);
  const attr: LineAttribution = { lines: 3, authors: [{ kind: "outside", tabId: null, agent: null, at: null }], runs: [{ from: 2, to: 2, author: 0 }] };
  expect(applicable(attr, "a\r\nb\r\n")).toBe(true);
  expect(applicable(attr, "a\r\nb\r\nc\r\n")).toBe(false);
  expect(applicable({ lines: 0, authors: [], runs: [] }, "")).toBe(false);
});
