import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { RemoveRepoDialog } from "./RemoveRepoDialog";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const draw = (over: Partial<Parameters<typeof RemoveRepoDialog>[0]> = {}) =>
  renderToStaticMarkup(
    <RemoveRepoDialog name="xdev" worktrees={3} tabs={[]} onConfirm={() => {}} onCancel={() => {}} {...over} />,
  );

it("says what leaves, that nothing is deleted from disk, and offers Remove and Cancel", () => {
  const html = draw();
  expect(html).toContain(en("project.remove.title", { name: "xdev" }));
  expect(html).toContain(en("project.remove.body", { count: 3 }));
  expect(html).toContain(en("project.remove.confirm"));
  expect(html).toContain(en("dialog.cancel"));
  expect(html).not.toContain("ws-remove-tabs");
  expect(en("project.remove.body", { count: 3 })).toMatch(/Nothing is deleted from disk/);
});

it("lists the open tabs that will close", () => {
  const html = draw({ tabs: ["claude", "zsh"] });
  expect(html).toContain(en("project.remove.tabs", { count: 2 }));
  expect(html).toContain("claude");
  expect(html).toContain("zsh");
});

it("shows an error code", () => {
  expect(draw({ error: "repo_unknown" })).toContain(en("error.repo_unknown"));
});

it("a single worktree has its own wording", () => {
  expect(en("project.remove.body", { count: 1 })).toMatch(/1 worktree leaves/);
});

it("keeps Vietnamese copy for every key", () => {
  for (const key of ["project.remove.title", "project.remove.body", "project.remove.confirm", "project.remove.tabs"]) {
    expect(translate("vi", key, { name: "x", count: 2 })).not.toBe(key);
  }
});
