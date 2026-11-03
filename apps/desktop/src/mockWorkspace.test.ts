import { describe, expect, it } from "vitest";
import { createMockApi } from "./api";
import { createMockWorkspace, DEMO_WORKSPACE } from "./mockWorkspace";

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

  it("repoUpdate refuses a taken short name with short_name_taken", async () => {
    const api = createMockWorkspace();
    const other = await api.repoAdd("/home/me/web");
    await expect(api.repoUpdate(other.id, { shortName: "xdev" })).rejects.toMatchObject({ code: "short_name_taken" });
    for (const bad of ["", "Web", "a b", "x:y", "a/b", "-x", "x".repeat(41)]) {
      await expect(api.repoUpdate(other.id, { shortName: bad })).rejects.toMatchObject({ code: "bad_name" });
    }
    await expect(api.repoUpdate(other.id, { baseRef: "-x" })).rejects.toMatchObject({ code: "bad_ref" });
    await expect(api.repoUpdate(other.id, { worktreeRoot: "rel/wt" })).rejects.toMatchObject({ code: "bad_path" });
    await expect(api.repoUpdate(other.id, { worktreeRoot: "/home/me/web/wt" })).rejects.toMatchObject({ code: "bad_path" });
    await expect(api.repoUpdate("nope", { shortName: "x" })).rejects.toMatchObject({ code: "repo_unknown" });
    // A refused patch changes nothing, even its valid fields.
    await expect(api.repoUpdate(other.id, { shortName: "front", baseRef: "-x" })).rejects.toMatchObject({ code: "bad_ref" });
    expect((await api.workspaceList())[1].shortName).toBe("web");

    const saved = await api.repoUpdate(other.id, { shortName: "front", baseRef: "origin/main", worktreeRoot: "/home/me/trees" });
    expect(saved).toMatchObject({ shortName: "front", baseRef: "origin/main", worktreeRoot: "/home/me/trees" });
    // Its own name again is not taken.
    await api.repoUpdate(other.id, { shortName: "front" });
  });

  it("adopt moves a found worktree into worktrees", async () => {
    const outside = { path: "/demo/wt/hand-made", name: "hand-made", branch: "hand", head: "5".repeat(40), start: null, primary: false, pinned: false, detached: false };
    const api = createMockWorkspace({ ...DEMO_WORKSPACE, found: { "demo-xdev": [outside] } });
    expect((await api.workspaceList())[0].found.map((w) => w.path)).toEqual([outside.path]);
    const adopted = await api.worktreeAdopt(outside.path);
    expect(adopted.path).toBe(outside.path);
    const [repo] = await api.workspaceList();
    expect(repo.found).toEqual([]);
    expect(repo.worktrees.map((w) => w.path)).toContain(outside.path);
    await expect(api.worktreeAdopt(outside.path)).rejects.toMatchObject({ code: "worktree_exists" });
    await expect(api.worktreeAdopt("/nowhere")).rejects.toMatchObject({ code: "worktree_unknown" });
    await expect(api.worktreeAdopt("/demo/xdev")).rejects.toMatchObject({ code: "primary_worktree" });
  });

  it("vaultAdd refuses the same path twice", async () => {
    const api = createMockWorkspace({ ...DEMO_WORKSPACE, docs: ["demo-xdev"] });
    const before = await api.vaultList();
    expect(before).toEqual([
      { id: "repo:demo-xdev", kind: "repo", path: "/demo/xdev/docs", name: "xdev", repoId: "demo-xdev", exists: true },
    ]);
    const shared = await api.vaultAdd("/demo/xdev-internal");
    expect(shared).toMatchObject({ kind: "shared", name: "xdev-internal", repoId: null, exists: true });
    await expect(api.vaultAdd("/demo/xdev-internal/")).rejects.toMatchObject({ code: "vault_exists" });
    await expect(api.vaultAdd("/demo/xdev/docs")).rejects.toMatchObject({ code: "vault_exists" });
    await expect(api.vaultAdd("relative")).rejects.toMatchObject({ code: "bad_path" });
    expect(await api.vaultList()).toHaveLength(2);
    // Shared vaults come by name, whatever the order they were added in.
    await api.vaultAdd("/demo/Alpha");
    expect((await api.vaultList()).filter((v) => v.kind === "shared").map((v) => v.name)).toEqual(["Alpha", "xdev-internal"]);
    await api.vaultForget("shared:/demo/Alpha");
    await api.vaultForget(shared.id);
    await expect(api.vaultForget(shared.id)).rejects.toMatchObject({ code: "vault_unknown" });
    await expect(api.vaultForget("repo:demo-xdev")).rejects.toMatchObject({ code: "vault_unknown" });
  });

  it("creates docs for a repo without a vault", async () => {
    const api = createMockWorkspace();
    expect((await api.vaultList())[0]).toMatchObject({ id: "repo:demo-xdev", exists: false });
    const made = await api.vaultCreateDocs("demo-xdev", "Start.md", "# Hi");
    expect(made).toMatchObject({ id: "repo:demo-xdev", exists: true });
    await expect(api.vaultCreateDocs("nope", "Start.md", "x")).rejects.toMatchObject({ code: "repo_unknown" });
    await expect(api.vaultCreateDocs("demo-xdev", "../x.md", "x")).rejects.toMatchObject({ code: "bad_path" });
  });
});

describe("mock shipping", () => {
  const files = ["src/session.ts"];

  it("push clears ahead and sets upstream", async () => {
    const api = createMockWorkspace();
    expect((await api.worktreeShip(FIRST)).upstream).toBeNull();
    await api.worktreeCommit(FIRST, files, "first");
    expect((await api.worktreeShip(FIRST)).range?.commits).toHaveLength(1);
    const pushed = await api.worktreePush(FIRST);
    expect(pushed.upstream).toMatchObject({ ahead: 0, behind: 0, branch: "oak" });
    expect(pushed.headPushed).toBe(true);
    await api.worktreeCommit(FIRST, ["src/status.ts"], "second");
    expect((await api.worktreeShip(FIRST)).upstream?.ahead).toBe(1);
    expect((await api.worktreePush(FIRST)).upstream?.ahead).toBe(0);
  });

  it("force push needs confirmation", async () => {
    const api = createMockWorkspace({ repos: DEMO_WORKSPACE.repos, changes: {}, remotes: { [FIRST]: { ahead: 1, behind: 1 } } });
    await expect(api.worktreeForcePush(FIRST, "b".repeat(40), false)).rejects.toMatchObject({ code: "needs_approval" });
    expect((await api.worktreeForcePush(FIRST, "b".repeat(40), true)).upstream).toMatchObject({ ahead: 0, behind: 0 });
  });

  it("force push honours the expected id and strips the remote from the base", async () => {
    const remotes = { [FIRST]: { ahead: 1, behind: 1 } };
    const api = createMockWorkspace({ repos: DEMO_WORKSPACE.repos, changes: {}, remotes });
    await expect(api.worktreeForcePush(FIRST, "c".repeat(40), true)).rejects.toMatchObject({ code: "push_rejected" });
    const [repo] = DEMO_WORKSPACE.repos;
    const onBase = { ...repo, baseRef: "origin/oak" };
    const api2 = createMockWorkspace({ repos: [onBase], changes: {}, remotes });
    await expect(api2.worktreeForcePush(FIRST, "b".repeat(40), true)).rejects.toMatchObject({ code: "force_base" });
  });

  it("sync pulls or pushes, not both; open without a pull request is gh_failed", async () => {
    const api = createMockWorkspace({ repos: DEMO_WORKSPACE.repos, changes: {}, remotes: { [FIRST]: { ahead: 0, behind: 1 } } });
    expect((await api.worktreeSync(FIRST)).upstream).toMatchObject({ ahead: 0, behind: 0 });
    const both = createMockWorkspace({ repos: DEMO_WORKSPACE.repos, changes: {}, remotes: { [FIRST]: { ahead: 1, behind: 1 } } });
    await expect(both.worktreeSync(FIRST)).rejects.toMatchObject({ code: "pull_diverged" });
    await expect(api.worktreePrOpen(FIRST, false)).rejects.toMatchObject({ code: "gh_failed" });
  });

  it("hook failure rejects with hook_failed and output", async () => {
    const api = createMockWorkspace({ ...DEMO_WORKSPACE, hookFailure: { [FIRST]: "lint failed" } });
    await expect(api.worktreeCommit(FIRST, files, "x")).rejects.toMatchObject({ code: "hook_failed", detail: "lint failed" });
    expect(await api.worktreeCommit(FIRST, files, "x")).not.toBeNull();
  });
});
