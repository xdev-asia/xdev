import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import type { WorktreeView } from "@/api";
import { NO_DETAILS } from "./worktreeDetails";
import { ParentPickerDialog, pickerRows } from "./ParentPickerDialog";

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

const wt = (path: string, over: Partial<WorktreeView> = {}): WorktreeView => ({
  path, name: path.split("/").pop()!, branch: `feat/${path.split("/").pop()}`, head: null, start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS, ...over,
});
const list = [wt("/code/xdev-oak"), wt("/code/xdev-elm", { title: "Login rework" }), wt("/work/other-pine", { branch: null, detached: true })];

it("filters by name, title, branch or path, ignoring case", () => {
  expect(pickerRows(list, "").map((r) => r.id)).toEqual(list.map((w) => w.path));
  expect(pickerRows(list, "OAK").map((r) => r.id)).toEqual(["/code/xdev-oak"]);
  expect(pickerRows(list, "login").map((r) => r.id)).toEqual(["/code/xdev-elm"]);
  expect(pickerRows(list, "feat/xdev-elm").map((r) => r.id)).toEqual(["/code/xdev-elm"]);
  expect(pickerRows(list, "/work/").map((r) => r.id)).toEqual(["/work/other-pine"]);
  expect(pickerRows(list, "zzz")).toEqual([]);
});

function draw(candidates: WorktreeView[], over: { onPick?: (p: string) => void; onCancel?: () => void } = {}) {
  return ParentPickerDialog({ worktree: wt("/code/xdev-main-feature"), candidates, onPick: over.onPick ?? (() => {}), onCancel: over.onCancel ?? (() => {}) });
}

it("titles the dialog with the worktree and shows the empty text with no candidates", () => {
  const tree = nodes(draw([]));
  const text = JSON.stringify(tree.map((n) => n.props.children));
  expect(text).toContain(translate("en", "lineage.picker.title", { name: "xdev-main-feature" }));
  const picker = tree.find((n) => n.props.onPick);
  expect(picker?.props.status).toBe(translate("en", "lineage.picker.empty"));
  expect(picker?.props.placeholder).toBe(translate("en", "lineage.picker.search"));
});

it("a pick calls onPick with the path; Escape closes the dialog", () => {
  const onPick = vi.fn();
  const onCancel = vi.fn();
  const tree = nodes(draw(list, { onPick, onCancel }));
  tree.find((n) => n.props.onPick)!.props.onPick("/code/xdev-oak");
  expect(onPick).toHaveBeenCalledWith("/code/xdev-oak");
  const dialog = tree.find((n) => n.type === "dialog")!;
  const preventDefault = vi.fn();
  dialog.props.onCancel({ preventDefault });
  expect(preventDefault).toHaveBeenCalled();
  expect(onCancel).toHaveBeenCalledOnce();
});

it("has no primary button: only Cancel", () => {
  const tree = nodes(draw(list));
  expect(tree.filter((n) => n.type === "button").length).toBe(1);
});
