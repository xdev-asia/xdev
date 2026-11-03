import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { removeRepo } from "./removeRepo";

const repo = () => structuredClone(DEMO_WORKSPACE.repos[0]);

it("forgets the repo, then closes the terminals of every worktree", async () => {
  const log: string[] = [];
  const r = repo();
  const code = await removeRepo(
    { forget: async (id) => void log.push(`forget ${id}`), closeWorktree: (path) => void log.push(`close ${path}`) },
    r,
  );
  expect(code).toBeNull();
  expect(log).toEqual([`forget ${r.id}`, ...r.worktrees.map((w) => `close ${w.path}`)]);
});

it("a failed forget keeps the tabs open and returns the code", async () => {
  const close = vi.fn();
  const code = await removeRepo({ forget: () => Promise.reject({ code: "repo_unknown" }), closeWorktree: close }, repo());
  expect(code).toBe("repo_unknown");
  expect(close).not.toHaveBeenCalled();
});

it("with the mock api the repo leaves the workspace list and nothing else changes", async () => {
  const api = createMockApi({}, { workspace: structuredClone(DEMO_WORKSPACE) });
  const [first] = await api.workspaceList();
  expect(await removeRepo({ forget: api.repoForget, closeWorktree: () => {} }, first)).toBeNull();
  expect((await api.workspaceList()).some((r) => r.id === first.id)).toBe(false);
});
