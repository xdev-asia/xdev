import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorktreeView } from "@/api";
import { translate } from "@/i18n";
import { NO_DETAILS } from "./worktreeDetails";
import { KanbanBoard, type KanbanBoardProps } from "./KanbanBoard";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const wt = (name: string, status: WorktreeView["status"], over: Partial<WorktreeView> = {}): WorktreeView => ({
  path: `/code/${name}`, name, branch: `feat/${name}`, head: null, start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS, status, ...over,
});

function html(over: Partial<KanbanBoardProps> = {}): string {
  return renderToStaticMarkup(
    <KanbanBoard
      worktrees={[wt("oak", "todo"), wt("elm", "in-review"), wt("main", null, { primary: true, branch: "main" }), wt("pine", null)]}
      selected="/code/elm"
      dots={{ "/code/oak": "working" }}
      profiles={{ "/code/oak": ["claude", "shell-1"] }}
      onSelect={() => {}}
      onMove={() => Promise.resolve()}
      onMoveError={() => {}}
      onClose={() => {}}
      {...over}
    />,
  );
}

it("draws a column per status in order, then No status, each with its count", () => {
  const out = html();
  const heads = [...out.matchAll(/<span class="kb-col-name">([^<]*)<\/span><span class="ws-group-count">(\d+)</g)].map((m) => [m[1], m[2]]);
  expect(heads).toEqual([["To do", "1"], ["In progress", "0"], ["In review", "1"], ["Completed", "0"], ["No status", "2"]]);
});

it("shows a hint in each empty column", () => {
  expect(html().match(/No worktrees\. Drag one here\./g)).toHaveLength(2);
});

it("reuses the sidebar card parts: dot, name, branch and agent chips, without shell chips", () => {
  const out = html();
  expect(out).toContain('data-status="working"');
  expect(out).toContain('class="ws-wt-name"');
  expect(out).toContain("feat/oak");
  expect(out).toContain('data-profile="claude"');
  expect(out).not.toContain('data-profile="shell-1"');
  expect(out).toContain('aria-current="true"');
});

it("gives a linked card a Move to button and leaves the primary worktree without one", () => {
  const out = html();
  expect(out.match(/aria-haspopup="menu"/g)).toHaveLength(3);
  expect(out).toContain("Move oak to another status");
  expect(out).not.toContain("Move main to another status");
});

it("uses no HTML5 drag attributes", () => {
  expect(html()).not.toMatch(/draggable|ondragstart/i);
});

it("says so when the project has no worktrees", () => {
  const out = html({ worktrees: [] });
  expect(out).toContain("No worktrees yet");
  expect(out).not.toContain("kb-col");
});

it("a card whose worktree came from a task carries the Task tag", () => {
  const item = { kind: "task" as const, url: ".xdev/tasks/tbk2a3c.md", title: "Plan" };
  const out = html({ worktrees: [wt("oak", "todo", { item }), wt("elm", "todo")] });
  expect(out.match(/ws-tag/g)).toHaveLength(1);
  expect(out).toContain(">Task<");
});

const heads = (out: string) => [...out.matchAll(/<span class="kb-col-name">([^<]*)<\/span><span class="ws-group-count">(\d+)</g)].map((m) => [m[1], m[2]]);
const names = (out: string) => [...out.matchAll(/class="ws-wt-name"[^>]*>([^<]*)</g)].map((m) => m[1]);
const NONE = { query: "", pinned: false, agents: false, tasks: false };

it("draws a toolbar with a search box, three chips and a settings button", () => {
  const out = html();
  expect(out.match(/class="search"/g)).toHaveLength(1);
  expect(out).toContain('aria-label="Search worktrees"');
  expect(out.match(/aria-pressed="false"/g)).toHaveLength(3);
  for (const label of ["Pinned", "Agent open", "From a task"]) expect(out).toContain(`>${label}<`);
  expect(out).toContain('aria-label="Board settings"');
  expect(out).toContain('aria-haspopup="dialog"');
});

it("has no primary button on the board", () => {
  expect(html({ onNew: () => {} })).not.toContain("btn-primary");
});

it("shows no toolbar for a project without worktrees", () => {
  const out = html({ worktrees: [] });
  expect(out).toContain("No worktrees yet");
  expect(out).not.toContain('class="search"');
});

it("narrows cards by the search and counts what is drawn", () => {
  const out = html({ view: { query: "oak" } });
  expect(names(out)).toEqual(["oak"]);
  expect(heads(out)).toEqual([["To do", "1"], ["In progress", "0"], ["In review", "0"], ["Completed", "0"], ["No status", "0"]]);
});

it("says so once when nothing matches", () => {
  const out = html({ view: { query: "zzz" } });
  expect(out.match(/No worktrees match/g)).toHaveLength(1);
  expect(html()).not.toContain("No worktrees match");
});

it("filters by a chip", () => {
  const out = html({ worktrees: [wt("oak", "todo", { pinned: true }), wt("elm", "todo")], view: { filter: { ...NONE, pinned: true } } });
  expect(names(out)).toEqual(["oak"]);
  expect(out).toContain('aria-pressed="true"');
});

it("hides the columns the settings hide", () => {
  const out = html({ view: { settings: { hidden: ["completed", "none"], density: "comfortable" } } });
  expect(out).not.toContain('data-column="completed"');
  expect(out).not.toContain('data-column="none"');
  expect(heads(out).map((h) => h[0])).toEqual(["To do", "In progress", "In review"]);
});

it("marks compact density on the board", () => {
  expect(html({ view: { settings: { hidden: [], density: "compact" } } })).toContain('data-density="compact"');
  expect(html()).toContain('data-density="comfortable"');
});

it("gives each visible column a ghost New worktree button when onNew is set", () => {
  const out = html({ onNew: () => {} });
  for (const s of ["To do", "In progress", "In review", "Completed", "No status"]) expect(out).toContain(`aria-label="New worktree in ${s}"`);
  expect(out.match(/aria-label="New worktree in /g)).toHaveLength(5);
  expect(out).toContain('class="ws-icon-btn kb-new"');
  const fewer = html({ onNew: () => {}, view: { settings: { hidden: ["completed", "none"], density: "comfortable" } } });
  expect(fewer.match(/aria-label="New worktree in /g)).toHaveLength(3);
});

it("has no New worktree button without onNew", () => {
  expect(html()).not.toContain("New worktree in");
});
