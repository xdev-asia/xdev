import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import { docsStatusItems } from "./docsStatusItems";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
type Over = { stale?: number; changes?: number | null; folder?: string | null };
const items = (over: Over, open = vi.fn()) =>
  docsStatusItems({ dirty: false, save: "saved", docs: 4, stale: 0, changes: 2, folder: "handbook", ...over }, t, open).filter(Boolean) as El[];
type El = ReactElement<Record<string, any>>;
const byKey = (list: El[], key: string) => list.find((n) => n.key === key);

it("stale opens docs, changes opens changes, untracked when changes is null", () => {
  const open = vi.fn();
  const list = items({ stale: 3 }, open);
  byKey(list, "docs-stale")!.props.onClick();
  byKey(list, "docs-changes")!.props.onClick();
  expect(open.mock.calls).toEqual([["docs"], ["changes"]]);
  const untracked = items({ changes: null });
  expect(byKey(untracked, "docs-changes")!.props.children).toBe(t("status.untracked"));
  expect(byKey(untracked, "docs-changes")!.props.onClick).toBeUndefined();
});

it("shows the folder and the count, and no stale item when none is stale", () => {
  const list = items({});
  expect(byKey(list, "docs-folder")!.props.children).toBe("handbook");
  expect(byKey(list, "docs-count")!.props.children).toBe(t("sidebar.count", { count: 4 }));
  expect(byKey(list, "docs-stale")).toBeUndefined();
});

it("says there is no folder while none is open", () => {
  const list = items({ folder: null });
  expect(list).toHaveLength(1);
  expect(list[0].props.children).toBe(t("status.noVault"));
});
