import { expect, it } from "vitest";
import type { FileCommands, QuickCommand } from "@/api";
import { buildSections, flatRows, oneLine, popoverKey, stepRow, type Env } from "./model";
import { selectCommands } from "./store";

const cmd = (id: string, label: string, command: string, scope: QuickCommand["scope"] = { type: "global" }, appendEnter = true): QuickCommand => ({
  id, label, scope, action: { type: "terminal", command, appendEnter },
});
const review: QuickCommand = { id: "qc-r", label: "Review", scope: { type: "global" }, action: { type: "agent", profile: "claude", prompt: "Review the diff\nand the tests" } };
const items = [cmd("qc-g", "Git status", "git status"), cmd("qc-a", "Tests", "cargo test", { type: "repo", repo: "/a" }), cmd("qc-b", "Other", "ls", { type: "repo", repo: "/b" }, false), review];
const sel = (repo: string | null, recent: string[] = []) => selectCommands({ items, recent, files: {} }, repo);
const env: Env = { hasTerminal: true, profiles: ["claude", "codex"] };
const file = (trusted: boolean): FileCommands => ({
  trusted, hash: "h", errors: [],
  commands: [{ label: "Lint", action: { type: "terminal", command: "pnpm lint", appendEnter: true } }, { label: "Ask", action: { type: "agent", profile: "ghost", prompt: "hi" } }],
});
const ids = (s: ReturnType<typeof buildSections>) => s.map((x) => `${x.id}:${x.rows.map((r) => r.label).join(",")}`);

it("lists project, file and global sections for the right repo only", () => {
  expect(ids(buildSections(sel("/a"), file(true), "", env))).toEqual(["project:Tests", "file:Lint,Ask", "global:Git status,Review"]);
  expect(ids(buildSections(sel("/b"), null, "", env))).toEqual(["project:Other", "global:Git status,Review"]);
  expect(ids(buildSections(sel(null), null, "", env))).toEqual(["global:Git status,Review"]);
});

it("puts Recent first, without a search, from the ids that are visible here", () => {
  expect(ids(buildSections(sel("/a", ["qc-b", "qc-review", "qc-g", "qc-a"]), null, "", env))[0]).toBe("recent:Git status,Tests");
  expect(buildSections(sel("/a", ["qc-g"]), null, "git", env).map((s) => s.id)).toEqual(["global"]);
});

it("search matches the label and the command text, not case", () => {
  expect(ids(buildSections(sel("/a"), null, "CARGO", env))).toEqual(["project:Tests"]);
  expect(ids(buildSections(sel("/a"), null, "status", env))).toEqual(["global:Git status"]);
  expect(ids(buildSections(sel("/a"), null, "diff", env))).toEqual(["global:Review"]);
  expect(buildSections(sel("/a"), null, "zzz", env)).toEqual([]);
});

it("each row has a badge and one line of text", () => {
  const rows = flatRows(buildSections(sel("/b"), null, "", env));
  expect(rows.map((r) => r.badge)).toEqual(["insert", "enter", "agent"]);
  expect(rows[2].detail).toBe("Review the diff …");
  expect(oneLine("  a\n\nb")).toBe("a …");
});

it("a terminal command is disabled without a terminal, with the reason", () => {
  const rows = flatRows(buildSections(sel("/a"), null, "", { ...env, hasTerminal: false }));
  expect(rows.map((r) => r.reason)).toEqual(["noTerminal", "noTerminal", null]);
});

it("untrusted file commands are listed, flagged and cannot run", () => {
  const sections = buildSections(sel("/a"), file(false), "", env);
  const files = sections.find((s) => s.id === "file")!;
  expect(files.untrusted).toBe(true);
  expect(files.rows.map((r) => r.reason)).toEqual(["untrusted", "untrusted"]);
  expect(buildSections(sel("/a"), file(true), "", env).find((s) => s.id === "file")!.untrusted).toBe(false);
});

it("an agent that is not a profile shows as not runnable", () => {
  const rows = flatRows(buildSections(sel("/a"), file(true), "", env)).filter((r) => r.source === "file");
  expect(rows.map((r) => r.reason)).toEqual([null, "unknownAgent"]);
  expect(flatRows(buildSections(sel("/a"), file(true), "", { ...env, profiles: null })).every((r) => r.reason === null)).toBe(true);
});

it("arrows skip rows that cannot run and wrap", () => {
  const rows = flatRows(buildSections(sel("/a"), file(true), "", env));
  const bad = rows.findIndex((r) => r.reason !== null);
  expect(bad).toBeGreaterThan(-1);
  let at = -1;
  const seen: number[] = [];
  for (let i = 0; i < rows.length + 1; i++) seen.push((at = stepRow(rows, at, 1)));
  expect(seen).not.toContain(bad);
  expect(stepRow(rows, 0, -1)).toBe(rows.length - 1 === bad ? rows.length - 2 : rows.length - 1);
});

it("Enter runs the active row; Shift+Enter runs a terminal command without Enter; Escape closes", () => {
  const rows = flatRows(buildSections(sel("/a"), null, "", env));
  expect(popoverKey(rows, 0, "Enter", false).effect).toEqual({ kind: "run", row: rows[0] });
  expect(popoverKey(rows, 0, "Enter", true).effect).toEqual({ kind: "run", row: rows[0], appendEnter: false });
  const agent = rows.findIndex((r) => r.badge === "agent");
  expect(popoverKey(rows, agent, "Enter", true).effect).toEqual({ kind: "run", row: rows[agent] });
  expect(popoverKey(rows, 0, "Escape", false).effect).toEqual({ kind: "close" });
  expect(popoverKey(rows, 0, "ArrowDown", false)).toEqual({ active: 1 });
  const off = flatRows(buildSections(sel("/a"), null, "", { ...env, hasTerminal: false }));
  expect(popoverKey(off, 0, "Enter", false).effect).toBeUndefined();
});
