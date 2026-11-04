import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { NO_DETAILS } from "./worktreeDetails";
import { DetailsDialog, detailsPatch } from "./DetailsDialog";

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => [initial, () => {}], useRef: () => ({ current: null }), useEffect: () => {} };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string) => translate("en", key) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

const wt = { ...DEMO_WORKSPACE.repos[0].worktrees[0], ...NO_DETAILS, comment: "note" };
const SAME = { title: "", comment: "note", status: "", parent: "", itemUrl: "", itemKind: "pr" as const };

it("saves only changed fields", () => {
  expect(detailsPatch(wt, SAME)).toEqual({});
  const patch = detailsPatch(wt, { ...SAME, status: "in-review" });
  expect(patch).toEqual({ status: "in-review" });
  expect(Object.keys(patch!)).toEqual(["status"]);
});

it("clears a field by sending null", () => {
  const set = { ...wt, title: "Old", status: "todo" as const };
  expect(detailsPatch(set, { ...SAME, title: "", status: "" })).toEqual({ title: null, status: null });
});

it("does not save while the work item link is unusable", () => {
  expect(detailsPatch(wt, { ...SAME, itemUrl: "nope" })).toBeNull();
});

it("shows bad_parent from the server", () => {
  const all = nodes(DetailsDialog({ worktree: wt, siblings: [], busy: false, error: "bad_parent", onSave: vi.fn(), onCancel: vi.fn() }));
  expect(all.find((n) => n.props.role === "alert")?.props.children).toBe(translate("en", "error.bad_parent"));
});
