import { describe, expect, it } from "vitest";
import type { ExportFile, ExportPlan } from "../api";
import { AGENTS_LIMIT_BYTES, docsFor, expectedOf, overLimit, writable } from "./plan";

const file = (path: string, status: ExportFile["status"], content = "x"): ExportFile => ({
  path,
  status,
  old: status === "new" ? null : "old",
  new: content,
  hash: `h-${path}`,
});

const plan: ExportPlan = {
  root: "/repo",
  files: [
    file("AGENTS.md", "changed"),
    file("CLAUDE.md", "unchanged"),
    file("GEMINI.md", "foreign"),
    file(".cursor/rules/xdev.mdc", "new"),
  ],
  docs: [
    { path: "a.md", title: "A", targets: ["agents"] },
    { path: "b.md", title: "B", targets: ["claude", "cursor"] },
  ],
  tokens: 1,
};

describe("export plan helpers", () => {
  it("only new and changed files are written", () => {
    expect(writable(plan).map((f) => f.path)).toEqual(["AGENTS.md", ".cursor/rules/xdev.mdc"]);
    expect(expectedOf(plan)).toEqual([
      { path: "AGENTS.md", hash: "h-AGENTS.md" },
      { path: ".cursor/rules/xdev.mdc", hash: "h-.cursor/rules/xdev.mdc" },
    ]);
  });

  it("nothing to write", () => {
    const quiet = { ...plan, files: [file("AGENTS.md", "unchanged"), file("CLAUDE.md", "foreign")] };
    expect(expectedOf(quiet)).toEqual([]);
  });

  it("docs per file follow their target", () => {
    expect(docsFor(plan, "AGENTS.md").map((d) => d.path)).toEqual(["a.md"]);
    expect(docsFor(plan, "CLAUDE.md").map((d) => d.path)).toEqual(["b.md"]);
    expect(docsFor(plan, ".cursor/rules/xdev.mdc").map((d) => d.path)).toEqual(["b.md"]);
    expect(docsFor(plan, "GEMINI.md")).toEqual([]);
    expect(docsFor(plan, "other.md")).toEqual([]);
  });

  it("the size warning counts UTF-8 bytes", () => {
    const ascii = "a".repeat(AGENTS_LIMIT_BYTES);
    expect(overLimit(file("AGENTS.md", "new", ascii))).toBe(false);
    expect(overLimit(file("AGENTS.md", "new", `${ascii}a`))).toBe(true);
    // 3 bytes each in UTF-8, so fewer characters cross the limit.
    expect(overLimit(file("AGENTS.md", "new", "ệ".repeat(AGENTS_LIMIT_BYTES / 2)))).toBe(true);
  });
});
