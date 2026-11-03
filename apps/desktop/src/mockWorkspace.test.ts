import { describe, expect, it } from "vitest";
import { createMockApi } from "./api";
import { createMockWorkspace } from "./mockWorkspace";

const FIRST = "/demo/wt/xdev-oak";

describe("mock workspace", () => {
  it("lists the demo repo with the primary checkout first", async () => {
    const api = createMockWorkspace();
    const repos = await api.workspaceList();
    expect(repos.map((r) => r.shortName)).toEqual(["xdev"]);
    expect(repos[0].worktrees[0].primary).toBe(true);
    expect(repos[0].worktrees.slice(1).every((w) => !w.primary && w.start !== null)).toBe(true);
    expect(await api.worktreeChanges(FIRST)).toHaveLength(3);
  });

  it("is part of the mock api and takes a seed", async () => {
    const api = createMockApi({}, { workspace: { repos: [], changes: {} } });
    expect(await api.workspaceList()).toEqual([]);
    expect((await createMockApi({}).workspaceList())[0].id).toBe("demo-xdev");
  });

  it("creates a worktree with a slug branch", async () => {
    const api = createMockWorkspace();
    const [repo] = await api.workspaceList();
    const wt = await api.worktreeCreate(repo.id, "Fix login", null);
    expect(wt).toMatchObject({ branch: "fix-login", name: "fix-login", primary: false, pinned: false });
    expect(wt.path).toBe("/demo/wt/xdev-fix-login");
    expect((await api.workspaceList())[0].worktrees.map((w) => w.branch)).toContain("fix-login");
    await expect(api.worktreeCreate(repo.id, "fix login", null)).rejects.toMatchObject({ code: "branch_exists" });
    await expect(api.worktreeCreate(repo.id, "...", null)).rejects.toMatchObject({ code: "bad_name" });
    await expect(api.worktreeCreate(repo.id, "x", "a b")).rejects.toMatchObject({ code: "bad_ref" });
    await expect(api.worktreeCreate("nope", "x", null)).rejects.toMatchObject({ code: "repo_unknown" });
  });

  it("gives a blank name a free word", async () => {
    const api = createMockWorkspace();
    const [repo] = await api.workspaceList();
    const first = await api.worktreeCreate(repo.id, "  ", null);
    const second = await api.worktreeCreate(repo.id, "", null);
    expect(first.branch).not.toBe(second.branch);
  });

  it("remove asks, then refuses dirty, then removes with force", async () => {
    const api = createMockWorkspace();
    await expect(api.worktreeRemove(FIRST, false, false)).rejects.toMatchObject({ code: "needs_approval" });
    await expect(api.worktreeRemove(FIRST, false, true)).rejects.toMatchObject({ code: "worktree_dirty" });
    await api.worktreeRemove(FIRST, true, true);
    const [repo] = await api.workspaceList();
    expect(repo.worktrees.some((w) => w.path === FIRST)).toBe(false);
    await expect(api.worktreeRemove(FIRST, true, true)).rejects.toMatchObject({ code: "worktree_unknown" });
    await expect(api.worktreeRemove(repo.path, true, true)).rejects.toMatchObject({ code: "primary_worktree" });
  });

  it("removes a clean worktree without force", async () => {
    const api = createMockWorkspace();
    await api.worktreeRemove("/demo/wt/xdev-elm", false, true);
    expect((await api.workspaceList())[0].worktrees).toHaveLength(2);
  });

  it("commit drops committed files from changes", async () => {
    const api = createMockWorkspace();
    await expect(api.worktreeCommit(FIRST, ["src/status.ts"], " ")).rejects.toMatchObject({ code: "empty_message" });
    const id = await api.worktreeCommit(FIRST, ["src/status.ts"], "add status");
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect((await api.worktreeChanges(FIRST)).map((c) => c.path)).toEqual(["docs/old-notes.md", "src/session.ts"]);
    expect(await api.worktreeCommit(FIRST, ["src/status.ts"], "again")).toBeNull();
  });

  it("counts lines from the pending changes", async () => {
    const api = createMockWorkspace();
    expect(await api.worktreeStat(FIRST)).toEqual({ files: 3, added: 4, removed: 3 });
    expect(await api.worktreeStat("/demo/wt/xdev-elm")).toEqual({ files: 0, added: 0, removed: 0 });
    expect(await api.worktreeStat("/demo/xdev")).toEqual({ files: 0, added: 0, removed: 0 });
    await expect(api.worktreeStat("/nope")).rejects.toMatchObject({ code: "worktree_unknown" });
  });

  it("pins and unpins a worktree", async () => {
    const api = createMockWorkspace();
    await api.worktreePin(FIRST, true);
    expect((await api.workspaceList())[0].worktrees.find((w) => w.path === FIRST)?.pinned).toBe(true);
    await api.worktreePin(FIRST, false);
    expect((await api.workspaceList())[0].worktrees.find((w) => w.path === FIRST)?.pinned).toBe(false);
    await expect(api.worktreePin("/nope", true)).rejects.toMatchObject({ code: "worktree_unknown" });
  });

  it("shows both sides of a changed file", async () => {
    const api = createMockWorkspace();
    expect(await api.worktreeFileDiff(FIRST, "src/status.ts")).toMatchObject({ old: null, skip: null });
    expect(await api.worktreeFileDiff(FIRST, "docs/old-notes.md")).toMatchObject({ new: null, skip: null });
    await expect(api.worktreeFileDiff(FIRST, "unchanged.ts")).rejects.toMatchObject({ code: "bad_arg" });
  });

  it("adds and forgets a repo", async () => {
    const api = createMockWorkspace();
    const repo = await api.repoAdd("/home/me/Notes App/");
    expect(repo).toMatchObject({ shortName: "notesapp", missing: false });
    expect(repo.worktrees).toHaveLength(1);
    expect(repo.worktrees[0].primary).toBe(true);
    await expect(api.repoAdd("/home/me/Notes App")).rejects.toMatchObject({ code: "repo_exists" });
    await api.repoForget(repo.id);
    await expect(api.repoForget(repo.id)).rejects.toMatchObject({ code: "repo_unknown" });
    expect(await api.workspaceList()).toHaveLength(1);
  });

  it("lists a folder, folders first, with the worktree changes applied", async () => {
    const api = createMockWorkspace();
    const names = async (dir: string) => (await api.worktreeListDir(FIRST, dir)).entries.map((e) => (e.dir ? `${e.name}/` : e.name));
    expect(await names("")).toEqual(["docs/", "src/", "package.json", "README.md"]);
    // An added file shows, a deleted one is gone.
    expect(await names("src")).toEqual(["lib/", "App.tsx", "main.tsx", "session.ts", "status.ts"]);
    expect(await names("docs")).toEqual(["guide.md"]);
    expect(await api.worktreeListDir(FIRST, "")).toMatchObject({ truncated: false });
    // The primary checkout has a tree too.
    expect(await api.worktreeListDir("/demo/xdev", "src/lib")).toEqual({ entries: [{ name: "format.ts", dir: false }], truncated: false });
  });

  it("refuses unknown worktrees, odd folders and missing ones", async () => {
    const api = createMockWorkspace();
    await expect(api.worktreeListDir("/nowhere", "")).rejects.toMatchObject({ code: "worktree_unknown" });
    for (const dir of ["..", "../x", "/x", "C:\\x","src/../x", ".git"]) {
      await expect(api.worktreeListDir(FIRST, dir)).rejects.toMatchObject({ code: "bad_path" });
    }
    await expect(api.worktreeListDir(FIRST, "nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(api.worktreeListDir(FIRST, "README.md")).rejects.toMatchObject({ code: "not_found" });
  });
});
