import { expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { createMockApi } from "@/api";
import { AccountsView } from "@/components/AccountsView";
import { AgentKitView } from "@/components/AgentKitView";
import { SquadsView } from "@/components/SquadsView";
import { BoardHost } from "@/tasks/board/BoardHost";
import type { Place } from "@/shell/places";
import { PlaceStage } from "./PlaceStage";

const api = createMockApi({});

function find(node: ReactNode, match: (e: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => find(n, match, out));
  else if (isValidElement<Record<string, unknown>>(node)) {
    if (match(node)) out.push(node);
    find(node.props.children as ReactNode, match, out);
  }
  return out;
}
const ofType = (tree: ReactNode, type: unknown) => find(tree, (e) => e.type === type);
const section = (tree: ReactNode, cls: string) => find(tree, (e) => e.type === "section" && String(e.props.className).split(" ").includes(cls))[0];

function stage(over: Partial<Parameters<typeof PlaceStage>[0]> = {}) {
  const props = {
    api,
    view: "tasks" as Place,
    mounted: new Set<Place>(["workspace", "tasks"]),
    tasks: { seq: 0 },
    board: { repos: null, onStart: async () => null },
    kit: { worktree: null, open: null },
    onOpenTask: vi.fn(),
    onOpenAgentContext: vi.fn(),
    ...over,
  };
  return { props, tree: PlaceStage(props) };
}

it("mounts nothing before a place is first shown", () => {
  const { tree } = stage({ mounted: new Set<Place>(["workspace"]) });
  expect(ofType(tree, BoardHost)).toHaveLength(0);
  expect(ofType(tree, SquadsView)).toHaveLength(0);
  expect(ofType(tree, AccountsView)).toHaveLength(0);
  expect(ofType(tree, AgentKitView)).toHaveLength(0);
});

it("shows only the place in view and hides the rest", () => {
  const { tree } = stage({ mounted: new Set<Place>(["workspace", "tasks", "squads"]) });
  expect(section(tree, "ws-tasks").props.hidden).toBe(false);
  expect(section(tree, "ws-squads").props.hidden).toBe(true);
});

it("gives the board the task focus and opens Agent runs for an agent task", () => {
  const { tree } = stage({ tasks: { seq: 3, task: "run-7" } });
  const board = ofType(tree, BoardHost)[0];
  expect(board.props.initialTab).toBe("runs");
  expect(board.props.initialRun).toBe("run-7");
  expect(board.props.initialTask).toBeUndefined();
  expect(board.key).toBe("run-7:3");
});

it("hands a file task, a tab and the decompose request to the board", () => {
  const { tree } = stage({ tasks: { seq: 2, boardTask: "t-1", tab: "list", decompose: true } });
  const board = ofType(tree, BoardHost)[0];
  expect(board.props.initialTab).toBe("list");
  expect(board.props.initialTask).toBe("t-1");
  expect(board.props.initialDecompose).toBe(true);
  expect(board.key).toBe("board:2");
});

it("opens a task from the squads view", () => {
  const { props, tree } = stage({ view: "squads", mounted: new Set<Place>(["workspace", "squads"]) });
  (ofType(tree, SquadsView)[0].props.onOpenTask as (id: string) => void)("run-9");
  expect(props.onOpenTask).toHaveBeenCalledWith("run-9");
});

it("keeps the kit mounted while hidden and opens agent context from it", () => {
  const { props, tree } = stage({ view: "workspace", mounted: new Set<Place>(["workspace", "kit"]) });
  expect(section(tree, "ws-kit").props.hidden).toBe(true);
  (ofType(tree, AgentKitView)[0].props.onOpenContext as () => void)();
  expect(props.onOpenAgentContext).toHaveBeenCalled();
});
