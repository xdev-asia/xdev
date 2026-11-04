import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { NO_DETAILS } from "./worktreeDetails";
import { createMockApi } from "@/mockApi";
import { DetailsDialog, detailsPatch } from "./DetailsDialog";
import { linkedRows, pastedItem } from "./LinkedWorkSearch";

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
  const all = nodes(DetailsDialog({ api: createMockApi({}), repoId: "r", worktree: wt, siblings: [], busy: false, error: "bad_parent", onSave: vi.fn(), onCancel: vi.fn() }));
  expect(all.find((n) => n.props.role === "alert")?.props.children).toBe(translate("en", "error.bad_parent"));
});

it("puts the picked pull request, with its title, into the patch", () => {
  const picked = { ...SAME, itemUrl: "https://github.com/acme/app/pull/12", itemKind: "pr" as const, itemTitle: "Fix the footer" };
  expect(detailsPatch(wt, picked)).toEqual({ item: { kind: "pr", url: "https://github.com/acme/app/pull/12", title: "Fix the footer" } });
});

it("removes the link by saving item null", () => {
  const linked = { ...wt, item: { kind: "pr" as const, url: "https://github.com/acme/app/pull/12", title: "Fix" } };
  expect(detailsPatch(linked, { ...SAME, itemUrl: "", itemTitle: null })).toEqual({ item: null });
});

it("lists pull requests, then issues, and reads a pasted link's kind", () => {
  const issue = { number: 3, url: "https://github.com/acme/app/issues/3", state: "open", title: "Bug" } as never;
  const pr = { number: 12, url: "https://github.com/acme/app/pull/12", state: "open", title: "Fix" } as never;
  expect(linkedRows([issue], [pr]).map((r) => [r.item.kind, r.meta])).toEqual([["pr", "#12 · open"], ["issue", "#3 · open"]]);
  expect(pastedItem(" https://github.com/acme/app/issues/3 ")).toEqual({ kind: "issue", url: "https://github.com/acme/app/issues/3", title: null });
  expect(pastedItem("bug footer")).toBeNull();
});
