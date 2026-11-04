import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import type { KeptView } from "@/api";
import { ReviewBranchesDialog } from "./ReviewBranchesDialog";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const kept = (branch: string, ahead: number): KeptView => ({ entry: { repoId: "r", branch, path: `/wt/${branch}`, keptMs: 1, reason: "deleted", title: null, comment: "", status: null, item: null }, ahead, archivedShown: false });

it("lists kept branches; an unmerged one needs a tick before Delete", () => {
  const html = renderToStaticMarkup(<ReviewBranchesDialog kept={[kept("a", 0), kept("b", 3)]} busy={false} onDelete={() => {}} onKeep={() => {}} onClose={() => {}} />);
  expect(html).toContain(translate("en", "review.unmerged", { count: 3 }));
  // Row a (merged) has a live Delete; row b (3 ahead) has it disabled until ticked.
  const rows = html.split("<li").slice(1);
  expect(rows[0]).not.toMatch(/ws-danger"[^>]*disabled/);
  expect(rows[1]).toMatch(/ws-danger"[^>]*disabled/);
});
