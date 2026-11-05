import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { EmptyState, IconButton, ListRow, StatusDot } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import type { Tab } from "@/workspace/sessions";
import { AgentDashboardView } from "./AgentDashboard";
import { dashboardBuckets } from "./dashboard";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (k: string, v?: Record<string, string | number>) => translate("en", k, v) }),
}));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children), ...nodes(node.props.leading), ...nodes(node.props.trailing)];
}
const en = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
const NOW = 10_000_000;
const names = { "/a": { name: "oak", branch: "feat/oak" } };
const tab = (id: string, status: string) => ({ id, worktree: "/a", profileId: "claude", agent: true, status, title: `T ${id}` }) as Tab;

function view(tabs: Tab[]) {
  const calls = { jump: [] as string[], dismiss: [] as string[] };
  const buckets = dashboardBuckets(tabs.map((t) => ({ tab: t, lastOutput: NOW - 120_000 })), names, new Set());
  const tree = nodes(AgentDashboardView({ buckets, now: NOW, onJump: (v) => void calls.jump.push(v), onDismiss: (v) => void calls.dismiss.push(v) }));
  return { calls, tree };
}

it("group headings carry counts", () => {
  const { tree } = view([tab("a", "needs-you"), tab("b", "failed"), tab("c", "working"), tab("d", "done")]);
  const headings = tree.filter((n) => n.props.className === "act-group").map((n) => n.props.children);
  expect(headings).toEqual(["Needs you (2)", "Working (1)", "Done (1)"]);
});

it("rows show a status dot and a meta line, and a click jumps", () => {
  const { calls, tree } = view([tab("a", "working")]);
  const row = tree.filter((n) => n.type === ListRow)[0]!;
  expect(row.props.meta).toMatch(/^oak · feat\/oak · .+/);
  expect(tree.find((n) => n.type === StatusDot)!.props).toMatchObject({ state: "working", pulse: true });
  row.props.onClick();
  expect(calls.jump).toEqual(["a"]);
});

it("Dismiss is only on done and failed rows and does not jump", () => {
  const { calls, tree } = view([tab("n", "needs-you"), tab("w", "working"), tab("f", "failed"), tab("d", "done")]);
  const buttons = tree.filter((n) => n.type === IconButton);
  expect(buttons).toHaveLength(2);
  let stopped = 0;
  for (const b of buttons) b.props.onClick({ stopPropagation: () => void stopped++ });
  expect(calls.dismiss).toEqual(["f:failed", "d:done"]);
  expect(stopped).toBe(2);
  expect(calls.jump).toEqual([]);
});

it("shows the empty state with no buckets", () => {
  const { tree } = view([tab("i", "idle")]);
  expect(tree.filter((n) => n.type === EmptyState)[0]!.props.title).toBe(en("activity.dashboard.empty"));
});
