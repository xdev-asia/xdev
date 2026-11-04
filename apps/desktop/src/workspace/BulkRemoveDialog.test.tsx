import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { NO_DETAILS } from "./worktreeDetails";
import { BulkRemoveDialog } from "./BulkRemoveDialog";
import type { WorktreeView } from "@/api";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const wt = (name: string): WorktreeView => ({ path: `/wt/${name}`, name, branch: name, head: null, start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS });
const base = { mode: "delete" as const, worktrees: [wt("p"), wt("b")], dirty: { "/wt/b": true }, children: {}, busy: false, onConfirm() {}, onCancel() {} };

it("lists every worktree, marks dirty ones and offers the anyway tick", () => {
  const html = renderToStaticMarkup(<BulkRemoveDialog {...base} />);
  expect(html).toContain("p</span>");
  expect(html).toContain(translate("en", "bulk.dirty"));
  expect(html).toContain(translate("en", "bulk.delete.anyway", { count: 1 }));
});

it("offers nested only when a selected parent has children, and says where they go otherwise", () => {
  expect(renderToStaticMarkup(<BulkRemoveDialog {...base} />)).not.toContain(translate("en", "bulk.nested"));
  const html = renderToStaticMarkup(<BulkRemoveDialog {...base} children={{ "/wt/p": ["/wt/c"] }} />);
  expect(html).toContain(translate("en", "bulk.nested"));
  expect(html).toContain(translate("en", "bulk.nested.note"));
});

it("shows the result with failures listed", () => {
  const html = renderToStaticMarkup(<BulkRemoveDialog {...base} result={{ ok: ["/wt/p"], failed: [{ path: "/wt/b", error: { code: "worktree_dirty" } }], kept: [] }} />);
  expect(html).toContain(translate("en", "bulk.done", { ok: 1, failed: 1 }));
  expect(html).toContain("b: ");
});
