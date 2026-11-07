import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { task } from "./fixtures";
import { BoardView, taskMenu, type BoardViewProps } from "./BoardView";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const tasks = [
  task("a", { title: "Fix login", status: "todo", priority: "p1", labels: ["auth"], assignee: "claude" }),
  task("b", { title: "Plan sync", status: "backlog" }),
  task("c", { title: "Ship it", status: "todo" }),
];

function html(over: Partial<BoardViewProps> = {}): string {
  return renderToStaticMarkup(
    <BoardView
      tasks={tasks}
      total={tasks.length}
      unreadable={[]}
      links={[]}
      tabOpen={() => true}
      agentName={(id) => `Agent ${id}`}
      onOpen={() => {}}
      onNew={() => {}}
      onStart={() => {}}
      onMove={() => {}}
      onOpenTab={() => {}}
      onClearFilters={() => {}}
      {...over}
    />,
  );
}

it("draws five columns in order with their counts", () => {
  const heads = [...html().matchAll(/<h3 class="x-board-col-title"[^>]*>([^<]*)<\/h3><span class="badge"[^>]*>(\d+)</g)].map((m) => [m[1], m[2]]);
  expect(heads).toEqual([["Backlog", "1"], ["To do", "2"], ["In progress", "0"], ["In review", "0"], ["Done", "0"]]);
});

it("a card shows the title, the priority, the labels and the agent's name", () => {
  const out = html();
  expect(out).toContain("Fix login");
  expect(out).toContain("P1 high");
  expect(out).toContain("auth");
  expect(out).toContain("Agent claude");
});

it("each column has a New task button", () => {
  expect(html().match(/aria-label="New task: /g)).toHaveLength(5);
});

it("a repo with no tasks shows the empty state; Split a goal appears only with onDecompose", () => {
  const empty = html({ tasks: [], total: 0 });
  expect(empty).toContain("No tasks in this repo yet");
  expect(empty).toContain("New task");
  expect(empty).not.toContain("Split a goal into tasks");
  expect(html({ tasks: [], total: 0, onDecompose: () => {} })).toContain("Split a goal into tasks");
});

it("filters that hide everything show No match and Clear filters", () => {
  const out = html({ tasks: [], total: 3 });
  expect(out).toContain("No tasks match these filters");
  expect(out).toContain("Clear filters");
});

it("unreadable files are one banner that lists the reasons", () => {
  const out = html({ unreadable: [{ file: ".xdev/tasks/x.md", reason: "no closing ---" }, { file: ".xdev/tasks/y.md", reason: "bad" }] });
  expect(out).toContain("Could not read 2 task files");
  expect(out).toContain(".xdev/tasks/x.md: no closing ---");
  expect(out.match(/class="banner /g)).toHaveLength(1);
});

it("a linked task with an open tab shows the dot and Open tab; with a closed tab only the note", () => {
  const link = { id: "a", worktree: "/wt", tabId: "t1", tabTitle: "claude" };
  const open = html({ links: [link] });
  expect(open).toContain("Working in claude");
  expect(open).toContain("Open tab");
  const gone = html({ links: [link], tabOpen: () => false });
  expect(gone).toContain("The tab that worked on this task is closed");
  expect(gone).not.toContain("Open tab");
  expect(gone).not.toContain("Working in");
});

it("the card menu ends with Delete, set apart and marked as destructive", () => {
  const onDelete = vi.fn();
  const move = vi.fn();
  const items = taskMenu(tasks[0]!, { onStart: () => {}, move, onDelete });
  expect(items.map((i) => i.id)).toEqual(["start", "sep", "move:backlog", "move:todo", "move:in-progress", "move:in-review", "move:done", "sep:delete", "delete"]);
  const del = items.at(-1)!;
  expect(del).toMatchObject({ labelKey: "board.delete", danger: true });
  del.run!();
  expect(onDelete).toHaveBeenCalledExactlyOnceWith(tasks[0]);
  // Without a delete handler the menu has no Delete.
  expect(taskMenu(tasks[0]!, { onStart: () => {}, move }).map((i) => i.id)).not.toContain("delete");
});
