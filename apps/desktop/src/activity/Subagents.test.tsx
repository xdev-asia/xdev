import { expect, it } from "vitest";
import type { ReactElement } from "react";
import { Badge, Disclosure, ListRow, StatusDot } from "@xdev-asia/ui";
import type { AgentSubagent } from "@/api";
import { translate } from "@/i18n";
import type { Tab } from "@/workspace/sessions";
import { subagentBadge, subagentCount, subagentDot, subagentItem } from "./Subagents";

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children), ...nodes(node.props.leading)];
}
const t = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
const NOW = 10_000_000;
const run = (id: string, status: string, over: Partial<AgentSubagent> = {}): AgentSubagent => ({ id, description: `Run ${id}`, agentType: "Explore", status, stepsTotal: 3, at: NOW - 60_000, ...over });
const tab = (status: string, subagents?: AgentSubagent[]) => ({ id: "a", worktree: "/a", profileId: "claude", agent: true, status, title: "T a", subagents }) as Tab;

it("a_run_is_done_failed_or_working_and_a_pending_one_in_a_stopped_tab_has_stopped", () => {
  expect(subagentDot("ok", "working")).toBe("done");
  expect(subagentDot("error", "working")).toBe("failed");
  expect(subagentDot("pending", "working")).toBe("working");
  expect(subagentDot("pending", "needs-you")).toBe("working");
  expect(subagentDot("pending", "done")).toBe("exited");
  expect(subagentDot("pending", "idle")).toBe("exited");
  expect(subagentCount([run("a", "ok"), run("b", "pending"), run("c", "pending")], "working")).toEqual({ total: 3, running: 2 });
  expect(subagentCount([run("b", "pending")], "done")).toEqual({ total: 1, running: 0 });
});

it("a_tab_without_runs_has_no_item_and_no_badge", () => {
  for (const runs of [undefined, []]) {
    expect(subagentItem(tab("working", runs), NOW, t, () => {})).toBeNull();
    expect(subagentBadge(tab("working", runs), t)).toBeNull();
  }
});

it("the_item_lists_each_run_indented_and_collapsible_with_a_dot_and_jumps_to_its_tab", () => {
  const jumps: string[] = [];
  const item = subagentItem(tab("working", [run("a", "ok"), run("b", "pending", { description: "", agentType: null, at: 0, stepsTotal: 0 })]), NOW, t, (id) => void jumps.push(id))!;
  expect(item.type).toBe("li");
  expect(item.props.className).toBe("act-sub");
  const tree = nodes(item);
  const group = tree.find((n) => n.type === Disclosure)!;
  expect(group.props).toMatchObject({ title: t("activity.subagents.title"), count: 2 });
  const rows = tree.filter((n) => n.type === ListRow);
  expect(rows.map((r) => r.props.title)).toEqual(["Run a", t("activity.subagents.untitled")]);
  expect(rows[0]!.props.meta).toMatch(/^Explore · Steps: 3 · .+/);
  expect(rows[1]!.props.meta).toBe(t("activity.subagents.steps", { count: 0 }));
  const dots = tree.filter((n) => n.type === StatusDot).map((n) => n.props);
  expect(dots).toEqual([
    { state: "done", pulse: false, label: t("activity.subagents.status.done") },
    { state: "working", pulse: true, label: t("activity.subagents.status.working") },
  ]);
  rows[1]!.props.onClick();
  expect(jumps).toEqual(["a"]);
});

it("the_badge_counts_runs_and_says_how_many_run", () => {
  const busy = subagentBadge(tab("working", [run("a", "ok"), run("b", "pending")]), t)!;
  expect(busy.type).toBe(Badge);
  expect(busy.props.children).toBe(t("activity.subagents.countRunning", { count: 2, running: 1 }));
  expect(subagentBadge(tab("done", [run("a", "ok"), run("b", "pending")]), t)!.props.children).toBe(t("activity.subagents.count", { count: 2 }));
});
