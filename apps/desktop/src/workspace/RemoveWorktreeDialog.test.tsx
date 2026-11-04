import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import type { WorktreeView } from "@/api";
import { NO_DETAILS } from "./worktreeDetails";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}], useRef: () => ({ current: null }), useEffect: () => {} };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

const wt: WorktreeView = { path: "/code/xdev-oak", name: "oak", branch: "feat/oak", head: null, start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS };

function draw(over: Partial<Parameters<typeof RemoveWorktreeDialog>[0]> = {}) {
  return nodes(RemoveWorktreeDialog({ worktree: wt, base: "main", dirty: false, busy: false, onConfirm: () => {}, onCancel: () => {}, ...over }));
}
const tick = (tree: Node[]) => tree.find((n) => n.props["data-dont-ask"] !== undefined);

it("shows Don't ask again for one clean worktree without children, when the shell handles it", () => {
  const tree = draw({ onDontAsk: () => {} });
  expect(tick(tree)).toBeDefined();
  expect(tree.some((n) => n.type === "span" && n.props.children === translate("en", "workspace.remove.dontAsk"))).toBe(true);
});

it("leaves the tick out without a handler, when dirty, or with children", () => {
  expect(tick(draw())).toBeUndefined();
  expect(tick(draw({ onDontAsk: () => {}, dirty: true }))).toBeUndefined();
  expect(tick(draw({ onDontAsk: () => {}, children: 1 }))).toBeUndefined();
});

it("confirm without the tick does not call onDontAsk", () => {
  const onDontAsk = vi.fn();
  const onConfirm = vi.fn();
  const confirm = draw({ onDontAsk, onConfirm }).find((n) => n.props.className === "ws-danger")!;
  confirm.props.onClick();
  expect(onConfirm).toHaveBeenCalledWith(false);
  expect(onDontAsk).not.toHaveBeenCalled();
});
