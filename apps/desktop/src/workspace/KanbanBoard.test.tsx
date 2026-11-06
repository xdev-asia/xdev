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
