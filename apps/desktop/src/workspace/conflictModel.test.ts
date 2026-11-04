import { expect, it } from "vitest";
import type { ConflictState } from "@/api";
import { conflictVars, operationText } from "./conflictModel";

const state = (over: Partial<ConflictState> = {}): ConflictState => ({ op: "rebase", files: ["a.ts", "b.ts"], onto: "main", step: [3, 7], ...over });
const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ""}`;

it("words a rebase with its step and target, and falls back to the plain name", () => {
  expect(operationText(state(), t)).toBe('conflicts.op.rebase{"step":3,"total":7,"onto":"main"}');
  expect(operationText(state({ step: null }), t)).toBe("conflicts.op.rebase.plain");
  expect(operationText(state({ onto: null }), t)).toBe("conflicts.op.rebase.plain");
});

it("words the other operations with what they apply", () => {
  expect(operationText(state({ op: "merge", step: null, onto: "topic" }), t)).toBe('conflicts.op.merge{"onto":"topic"}');
  expect(operationText(state({ op: "cherry-pick", step: null, onto: "abc1234" }), t)).toBe('conflicts.op.cherry-pick{"onto":"abc1234"}');
  expect(operationText(state({ op: "revert", step: null, onto: "abc1234" }), t)).toBe('conflicts.op.revert{"onto":"abc1234"}');
  expect(operationText(state({ op: "merge", step: null, onto: null }), t)).toBe("conflicts.op.merge.plain");
});

it("gives the recipe its variables in plain English", () => {
  expect(conflictVars(state(), "me/oak")).toEqual({ branch: "me/oak", operation: "rebase (step 3 of 7)", files: "a.ts\nb.ts", onto: "main" });
  expect(conflictVars(state({ op: "cherry-pick", step: null, onto: null, files: [] }), "x")).toEqual({ branch: "x", operation: "cherry-pick", files: "", onto: "" });
});
