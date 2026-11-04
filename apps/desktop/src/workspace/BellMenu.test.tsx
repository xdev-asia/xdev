import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { BellMenu, bellCount, type BellRow } from "./BellMenu";
import type { Tab } from "./sessions";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const NOW = 10_000_000;
const row = (id: string, status: Tab["status"], unreadAt: number, worktree: string, name: string): BellRow => ({
  tab: { id, status, unreadAt, unread: true } as Tab,
  worktree,
  name,
});

it("bell lists unread tabs, newest first, and jumps", () => {
  const jumps: string[] = [];
  let closed = 0;
  const rows = [row("a", "done", NOW - 5 * 60_000, "oak", "Claude"), row("b", "needs-you", NOW - 1000, "elm", "Codex")];
  const tree = nodes(BellMenu({ rows, now: NOW, onJump: (tab) => void jumps.push(tab.id), onClose: () => void closed++ }));
  const items = tree.filter((n) => n.props.role === "menuitem");
  expect(items).toHaveLength(2);
  expect(items[0].props["aria-label"]).toBe(en("status.bell.row", { worktree: "elm", name: "Codex", state: en("workspace.tabs.status.needs-you"), age: en("ago.now") }));
  expect(items[1].props["aria-label"]).toBe("oak, Claude, Done, 5 min");
  items[1].props.onClick();
  expect(jumps).toEqual(["a"]);
  // Each row carries its state glyph.
  expect(nodes(items[0].props.children).find((n) => n.props.className === "ws-glyph")!.props["data-status"]).toBe("needs-you");
  expect(nodes(items[0].props.children).find((n) => n.props.className === "ws-bell-state")!.props.children).toBe(en("workspace.tabs.status.needs-you"));

  tree.find((n) => n.props.className === "ws-menu-backdrop")!.props.onClick();
  tree.find((n) => n.props.className === "ws-bell-pop")!.props.onKeyDown({ key: "Escape", preventDefault() {} });
  expect(closed).toBe(2);
});

it("an empty bell says so", () => {
  const tree = nodes(BellMenu({ rows: [], now: NOW, onJump() {}, onClose() {} }));
  expect(tree.some((n) => n.props.role === "menuitem")).toBe(false);
  expect(tree.find((n) => n.props.role === "status")!.props.children).toBe(en("status.bell.empty"));
});

it("bell count shows 99+", () => {
  expect(bellCount(1)).toBe("1");
  expect(bellCount(99)).toBe("99");
  expect(bellCount(120)).toBe("99+");
});

it("View activity calls onViewActivity, and is absent without the prop", () => {
  let n = 0;
  const tree = nodes(BellMenu({ rows: [], now: NOW, onJump() {}, onViewActivity: () => void n++, onClose() {} }));
  const button = tree.find((x) => x.props.className === "ws-bell-activity")!;
  expect(button.type).toBe(Button);
  expect(button.props.variant).toBe("secondary");
  expect(button.props.type).toBe("button");
  expect(button.props.children).toBe(en("status.bell.viewActivity"));
  button.props.onClick();
  expect(n).toBe(1);
  expect(nodes(BellMenu({ rows: [], now: NOW, onJump() {}, onClose() {} })).some((x) => x.props.className === "ws-bell-activity")).toBe(false);
});
