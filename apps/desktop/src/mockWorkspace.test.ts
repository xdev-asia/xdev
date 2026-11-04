import { describe, expect, it } from "vitest";
import { createMockApi, SETUP_PROFILE } from "./api";
import { createMockWorkspace, DEFAULT_GIT_SETTINGS, DEMO_WORKSPACE } from "./mockWorkspace";
import { NO_DETAILS } from "@/workspace/worktreeDetails";

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
    const { worktree: wt } = await api.worktreeCreate(repo.id, "Fix login", null);
    expect(wt).toMatchObject({ branch: "fix-login", name: "fix-login", primary: false, pinned: false });
    expect(wt.path).toBe("/demo/wt/xdev-fix-login");
    expect((await api.workspaceList())[0].worktrees.map((w) => w.branch)).toContain("fix-login");
    // The desktop never refuses a taken name: it is made as `fix-login-2`.
    expect((await api.worktreeCreate(repo.id, "fix login", null)).worktree.branch).toBe("fix-login-2");
    await expect(api.worktreeCreate(repo.id, "...", null)).rejects.toMatchObject({ code: "bad_name" });
    await expect(api.worktreeCreate(repo.id, "x", "a b")).rejects.toMatchObject({ code: "bad_ref" });
    await expect(api.worktreeCreate("nope", "x", null)).rejects.toMatchObject({ code: "repo_unknown" });
  });

  it("trusts shared paths and tabs by hash and links only a trusted list on create", async () => {
    const seed = { ...DEMO_WORKSPACE, repoFiles: { "/demo/xdev": { shared: ["node_modules", ".env.local"], tabs: [{ title: "dev", color: "#4a9", command: "pnpm dev" }], unknown: ["worktree.foo"], problems: ["tabs[1]: needs a command"], linkErrors: { ".env.local": "missing in the main checkout" } } } };
    const api = createMockWorkspace(seed);
    const [repo] = await api.workspaceList();
    const primary = repo.worktrees[0].path;
    const hooks = await api.repoHooks(primary);
    expect(hooks).toMatchObject({ shared: ["node_modules", ".env.local"], sharedTrusted: false, tabsTrusted: false, unknown: ["worktree.foo"], problems: ["tabs[1]: needs a command"] });
    expect((await api.worktreeCreate(repo.id, "a", null)).shared).toEqual([]);

    await expect(api.repoHookTrust(primary, "shared", "stale")).rejects.toMatchObject({ code: "hook_untrusted" });
    expect((await api.repoHookTrust(primary, "shared", hooks.sharedHash!)).sharedTrusted).toBe(true);
    expect((await api.repoHookTrust(primary, "tabs", hooks.tabsHash!)).tabsTrusted).toBe(true);
    expect((await api.worktreeCreate(repo.id, "b", null)).shared).toEqual([
      { path: "node_modules", ok: true, error: null },
      { path: ".env.local", ok: false, error: "missing in the main checkout" },
    ]);
  });

  it("names branches with the git settings prefix and stores the settings normalized", async () => {
    const api = createMockWorkspace({ ...DEMO_WORKSPACE, gitUserName: "duy" });
    const [repo] = await api.workspaceList();
    expect(await api.gitUserName()).toBe("duy");
    expect((await api.gitSettings()).branchPrefix).toBe("git-username");
    const byUser = await api.worktreeCreate(repo.id, "one", null);
    expect(byUser.worktree).toMatchObject({ branch: "duy/one", path: "/demo/wt/xdev-one" });
    expect(byUser.shared).toEqual([]);

    const saved = await api.setGitSettings({ ...DEFAULT_GIT_SETTINGS, branchPrefix: "custom", branchPrefixCustom: " /team//ui/ ", refreshLocalBaseOnCreate: true, prDraft: true });
    expect(saved).toEqual({ ...DEFAULT_GIT_SETTINGS, branchPrefix: "custom", branchPrefixCustom: "team/ui", refreshLocalBaseOnCreate: true, prDraft: true });
    expect((await api.worktreeCreate(repo.id, "two", null)).worktree.branch).toBe("team/ui/two");

    await api.setGitSettings({ ...saved, branchPrefixCustom: "a b" });
    await expect(api.worktreeCreate(repo.id, "three", null)).rejects.toMatchObject({ code: "bad_branch_prefix" });
    await api.setGitSettings({ ...saved, branchPrefix: "none", branchPrefixCustom: "a b" });
    expect((await api.worktreeCreate(repo.id, "three", null)).worktree.branch).toBe("three");
  });

  it("gives a blank name a free word", async () => {
    const api = createMockWorkspace();
    const [repo] = await api.workspaceList();
    const first = await api.worktreeCreate(repo.id, "  ", null);
    const second = await api.worktreeCreate(repo.id, "", null);
    expect(first.worktree.branch).not.toBe(second.worktree.branch);
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

  it("the demo repo has an identity, and repoUpdate sets, clears and checks it", async () => {
    const api = createMockWorkspace();
    const [repo] = await api.workspaceList();
    expect(repo).toMatchObject({ color: "teal", icon: { kind: "emoji", value: "🚀" }, ghAccount: null, localIssueCommand: "" });
    const other = await api.repoAdd("/home/me/web");
    expect(other).toMatchObject({ color: null, icon: null, ghAccount: null });
    for (const color of ["pink", "#abc", "#AABBCC"]) await api.repoUpdate(other.id, { color });
    for (const bad of ["", "#abcd", "abc", "blue"]) await expect(api.repoUpdate(other.id, { color: bad })).rejects.toMatchObject({ code: "bad_color" });
    for (const bad of ["", "ab", "🚀🚀", "x🚀"]) await expect(api.repoUpdate(other.id, { icon: { kind: "emoji", value: bad } })).rejects.toMatchObject({ code: "bad_icon" });
    await expect(api.repoUpdate(other.id, { localIssueCommand: "x".repeat(64 * 1024 + 1) })).rejects.toMatchObject({ code: "too_large" });
    const set = await api.repoUpdate(other.id, { icon: { kind: "emoji", value: "👩‍💻" }, ghAccount: { host: "github.com", user: "me" }, localIssueCommand: "Fix {title}" });
    expect(set).toMatchObject({ icon: { kind: "emoji", value: "👩‍💻" }, ghAccount: { host: "github.com", user: "me" }, localIssueCommand: "Fix {title}" });
    // An absent key leaves the field; null clears it.
    await api.repoUpdate(other.id, { shortName: "front" });
    expect((await api.workspaceList())[1]).toMatchObject({ color: "#AABBCC", ghAccount: { user: "me" } });
    const cleared = await api.repoUpdate(other.id, { color: null, icon: null, ghAccount: null, localIssueCommand: "" });
    expect(cleared).toMatchObject({ color: null, icon: null, ghAccount: null, localIssueCommand: "" });
  });

  it("ghLogins lists the demo logins with one active", async () => {
    const logins = await createMockWorkspace().ghLogins();
    expect(logins.length).toBeGreaterThan(1);
    expect(logins.filter((l) => l.active)).toHaveLength(1);
  });

  it("adopt moves a found worktree into worktrees", async () => {
    const outside = { path: "/demo/wt/hand-made", name: "hand-made", branch: "hand", head: "5".repeat(40), start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS };
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

  it("counts the range against the upstream when the git settings say so", async () => {
    const api = createMockWorkspace({ ...DEMO_WORKSPACE, git: { compareAgainstUpstream: true } });
    await api.worktreeCommit(FIRST, files, "first");
    // No upstream yet: the base stays.
    expect(await api.worktreeShip(FIRST)).toMatchObject({ rangeBase: "main", aheadOfBase: true });
    await api.worktreePush(FIRST);
    await api.worktreeCommit(FIRST, ["src/status.ts"], "second");
    const ship = await api.worktreeShip(FIRST);
    expect(ship).toMatchObject({ base: "main", rangeBase: "origin/oak", aheadOfBase: true });
    expect(ship.range?.commits.map((c) => c.message)).toEqual(["second"]);
    expect((await api.worktreePush(FIRST)).range?.commits).toEqual([]);
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

describe("mock review", () => {
  const note = (id: string, body = "fix it") => ({
    id,
    file: "src/session.ts",
    startLine: 1,
    line: 2,
    anchor: "a\nb",
    body,
    createdAt: 1,
    sentAt: null,
    outdated: false,
  });

  it("lists the files against the start with their stage state", async () => {
    const api = createMockWorkspace();
    const r = await api.worktreeReview(FIRST, null);
    expect(r.base.kind).toBe("start");
    expect(r.branch).toBe("oak");
    expect(r.baseRef).toBe("main");
    expect(r.files.map((f) => f.path)).toEqual(["docs/old-notes.md", "src/session.ts", "src/status.ts"]);
    expect(r.files.every((f) => !f.staged && f.unstaged)).toBe(true);
  });

  it("stages and unstages a file", async () => {
    const api = createMockWorkspace();
    await api.worktreeStage(FIRST, ["src/session.ts"], true);
    let f = (await api.worktreeReview(FIRST, null)).files.find((x) => x.path === "src/session.ts");
    expect(f).toMatchObject({ staged: true, unstaged: false });
    await api.worktreeStage(FIRST, ["src/session.ts"], false);
    f = (await api.worktreeReview(FIRST, null)).files.find((x) => x.path === "src/session.ts");
    expect(f).toMatchObject({ staged: false, unstaged: true });
    await expect(api.worktreeStage(FIRST, ["nope.ts"], true)).rejects.toMatchObject({ code: "bad_arg" });
  });

  it("takes a branch or commit base and refuses an unknown one", async () => {
    const api = createMockWorkspace();
    const branches = await api.worktreeBranches(FIRST);
    expect(branches.some((b) => b.name === "main" && !b.remote)).toBe(true);
    expect((await api.worktreeReview(FIRST, "main")).base).toMatchObject({ kind: "ref", name: "main" });
    expect((await api.worktreeReview(FIRST, "abc1234")).base.kind).toBe("ref");
    await expect(api.worktreeReview(FIRST, "nope")).rejects.toMatchObject({ code: "bad_ref" });
    await expect(api.worktreeReview(FIRST, "--x")).rejects.toMatchObject({ code: "bad_ref" });
  });

  it("reads one file's sides by base id", async () => {
    const api = createMockWorkspace();
    const r = await api.worktreeReview(FIRST, null);
    expect(await api.worktreeReviewFile(FIRST, r.base.id, "src/status.ts")).toMatchObject({ old: null, skip: null });
    await expect(api.worktreeReviewFile(FIRST, "main", "src/status.ts")).rejects.toMatchObject({ code: "bad_ref" });
  });

  it("keeps notes per worktree and checks them", async () => {
    const api = createMockWorkspace();
    expect(await api.reviewNotes(FIRST)).toEqual([]);
    expect(await api.reviewNotesPut(FIRST, [note("a"), note("b")])).toHaveLength(2);
    expect((await api.reviewNotes(FIRST)).map((n) => n.id)).toEqual(["a", "b"]);
    await expect(api.reviewNotesPut(FIRST, [note("c", "  ")])).rejects.toMatchObject({ code: "bad_note" });
    await expect(api.reviewNotesPut(FIRST, [note("d"), note("d")])).rejects.toMatchObject({ code: "bad_note" });
    await expect(api.reviewNotesPut(FIRST, [{ ...note("e"), startLine: 5 }])).rejects.toMatchObject({ code: "bad_note" });
    await expect(api.reviewNotesPut(FIRST, [{ ...note("f"), file: "../x" }])).rejects.toMatchObject({ code: "bad_note" });
    expect(await api.reviewNotes(FIRST)).toHaveLength(2);
    await expect(api.reviewNotes("/nowhere")).rejects.toMatchObject({ code: "worktree_unknown" });
  });
});

describe("mock repo hooks", () => {
  const seed = { ...DEMO_WORKSPACE, repoFiles: { "/demo/xdev": { setup: "pnpm i", archive: "echo bye", archiveOutput: "bye" } } };

  it("reads the shared scripts untrusted until trusted by hash", async () => {
    const api = createMockWorkspace(seed);
    const hooks = await api.repoHooks(FIRST);
    expect(hooks.setup).toMatchObject({ text: "pnpm i", shared: true, trusted: false });
    await expect(api.worktreeArchiveRun(FIRST)).rejects.toMatchObject({ code: "hook_untrusted" });
    await expect(api.repoHookTrust(FIRST, "archive", "stale")).rejects.toMatchObject({ code: "hook_untrusted" });
    const after = await api.repoHookTrust(FIRST, "archive", hooks.archive!.hash);
    expect(after.archive?.trusted).toBe(true);
    expect(await api.worktreeArchiveRun(FIRST)).toEqual({ ran: true, code: 0, output: "bye" });
  });

  it("joins shared and local scripts as the source says", async () => {
    const api = createMockWorkspace(seed);
    await api.repoUpdate("demo-xdev", { scriptSource: "both", localSetup: "make" });
    const hooks = await api.repoHooks(FIRST);
    expect(hooks.setup?.text).toBe("pnpm i\nmake");
    await api.repoUpdate("demo-xdev", { scriptSource: "local", localArchive: "" });
    expect(await api.worktreeArchiveRun(FIRST)).toEqual({ ran: false, code: null, output: "" });
  });

  it("round-trips docsDir and lists the repo vault at that folder", async () => {
    const api = createMockWorkspace();
    expect((await api.workspaceList())[0].docsDir).toBe("docs");
    const view = await api.repoUpdate("demo-xdev", { docsDir: "handbook\\en" });
    expect(view.docsDir).toBe("handbook/en");
    expect((await api.workspaceList())[0].docsDir).toBe("handbook/en");
    const vault = (await api.vaultList()).find((v) => v.repoId === "demo-xdev")!;
    expect(vault.path).toBe("/demo/xdev/handbook/en");
    // An empty value goes back to the default.
    expect((await api.repoUpdate("demo-xdev", { docsDir: "" })).docsDir).toBe("docs");
    // Absolute paths, drives and `..` are refused and change nothing.
    for (const bad of ["../x", "a/../b", "/x", "C:\\x", "C:/x"]) {
      await expect(api.repoUpdate("demo-xdev", { docsDir: bad })).rejects.toMatchObject({ code: "bad_path" });
    }
    expect((await api.workspaceList())[0].docsDir).toBe("docs");
  });

  it("runs setup in the mock terminal and reports its exit", async () => {
    const api = createMockApi({}, { workspace: seed });
    await expect(api.ptySpawn("s", FIRST, SETUP_PROFILE, null, 80, 24, () => {})).rejects.toMatchObject({ code: "hook_untrusted" });
    const hash = (await api.repoHooks(FIRST)).setup!.hash;
    await api.repoHookTrust(FIRST, "setup", hash);
    const exit = new Promise((resolve) => void api.onPtyExit(resolve));
    const info = await api.ptySpawn("s", FIRST, SETUP_PROFILE, null, 80, 24, () => {});
    expect(info.agent).toBe(false);
    expect(await exit).toEqual({ id: "s", code: 0 });
  });

  it("refuses to run setup when the repo's policy is skip, like Rust", async () => {
    const api = createMockApi({}, { workspace: seed });
    await api.repoHookTrust(FIRST, "setup", (await api.repoHooks(FIRST)).setup!.hash);
    await api.repoUpdate("demo-xdev", { setupPolicy: "skip" });
    await expect(api.ptySpawn("s", FIRST, SETUP_PROFILE, null, 80, 24, () => {})).rejects.toMatchObject({ code: "setup_skipped" });
  });

  it("makes a taken name as -2, -3 and keeps the typed text as the title", async () => {
    const api = createMockWorkspace();
    const [repo] = await api.workspaceList();
    const first = (await api.worktreeCreate(repo.id, "feat one", null)).worktree;
    expect(first).toMatchObject({ branch: "feat-one", title: null });
    const second = (await api.worktreeCreate(repo.id, "feat one", null)).worktree;
    expect(second).toMatchObject({ branch: "feat-one-2", title: "feat one", path: "/demo/wt/xdev-feat-one-2" });
    expect((await api.worktreeCreate(repo.id, "feat one", null)).worktree.branch).toBe("feat-one-3");
    const long = "a".repeat(60);
    await api.worktreeCreate(repo.id, long, null);
    expect((await api.worktreeCreate(repo.id, long, null)).worktree.branch).toBe(`${"a".repeat(46)}-2`);
    expect((await api.worktreeCreate(repo.id, "🚀 launch", null)).worktree).toMatchObject({ branch: "launch", title: "🚀 launch" });
  });

  it("previews the name a create would get, without making anything", async () => {
    const api = createMockWorkspace();
    const [repo] = await api.workspaceList();
    expect(await api.worktreeNamePreview(repo.id, "feat one")).toEqual({ branch: "feat-one", folder: "xdev-feat-one", suffixed: false });
    await api.worktreeCreate(repo.id, "feat one", null);
    expect(await api.worktreeNamePreview(repo.id, "feat one")).toEqual({ branch: "feat-one-2", folder: "xdev-feat-one-2", suffixed: true });
    expect(await api.worktreeNamePreview(repo.id, "  ")).toEqual({ branch: "", folder: "", suffixed: false });
    await expect(api.worktreeNamePreview(repo.id, "...")).rejects.toMatchObject({ code: "bad_name" });
    await expect(api.worktreeNamePreview("nope", "x")).rejects.toMatchObject({ code: "repo_unknown" });
    expect((await api.workspaceList())[0].worktrees.map((w) => w.branch)).not.toContain("feat-one-2");
  });

  it("creates a git project named after the request, with its branch", async () => {
    const api = createMockWorkspace();
    const made = await api.repoCreate({ parent: "/code", name: " demo ", kind: "git", branch: "", firstCommit: true });
    if (made.kind !== "git") throw new Error("git expected");
    expect(made.repo).toMatchObject({ shortName: "demo", path: "/code/demo", baseRef: "main" });
    expect((await api.workspaceList()).map((r) => r.shortName)).toContain("demo");
    const trunk = await api.repoCreate({ parent: "/code/", name: "other", kind: "git", branch: "trunk", firstCommit: false });
    if (trunk.kind !== "git") throw new Error("git expected");
    expect(trunk.repo.baseRef).toBe("trunk");
    expect(trunk.repo.worktrees[0]).toMatchObject({ branch: "trunk", head: null });
  });

  it("creates a plain folder in the sidebar and refuses bad requests", async () => {
    const api = createMockWorkspace();
    const made = await api.repoCreate({ parent: "/code", name: "notes", kind: "folder", branch: "", firstCommit: false });
    expect(made).toMatchObject({ kind: "folder", folder: { path: "/code/notes", name: "notes" } });
    expect((await api.workspaceSidebar()).some((i) => i.kind === "folder" && i.folder.name === "notes")).toBe(true);
    const req = (name: string, over = {}) => ({ parent: "/code", name, kind: "git" as const, branch: "", firstCommit: true, ...over });
    for (const bad of ["", "a/b", "CON", "nul.txt", "x:", "dots."]) await expect(api.repoCreate(req(bad))).rejects.toMatchObject({ code: "bad_name" });
    await expect(api.repoCreate(req("x", { branch: "a b" }))).rejects.toMatchObject({ code: "bad_name" });
    await expect(api.repoCreate(req("notes"))).rejects.toMatchObject({ code: "exists" });
    await expect(api.repoCreate(req("x", { parent: "relative" }))).rejects.toMatchObject({ code: "not_found" });
  });

  describe("branch rename and conflicts", () => {
    const CONFLICTED = { ...DEMO_WORKSPACE, conflicts: { [FIRST]: { op: "rebase" as const, files: ["src/session.ts"], onto: "main", step: [3, 7] as [number, number] } } };

    it("marks only a blank-named worktree as auto-named, and renames it under its prefix", async () => {
      const api = createMockWorkspace({ ...DEMO_WORKSPACE, git: { branchPrefix: "custom", branchPrefixCustom: "me" } });
      const [repo] = await api.workspaceList();
      const { worktree: auto } = await api.worktreeCreate(repo.id, "", null);
      expect(auto.autoName).toBe(true);
      expect((await api.worktreeCreate(repo.id, "typed", null)).worktree.autoName).toBe(false);
      const view = await api.worktreeRenameBranch(auto.path, "Fix the footer");
      expect(view).toMatchObject({ branch: "me/fix-the-footer", title: "fix the footer", autoName: false, path: auto.path });
      // A taken name takes the next suffix.
      const { worktree: other } = await api.worktreeCreate(repo.id, "", null);
      expect((await api.worktreeRenameBranch(other.path, "fix the footer")).branch).toBe("me/fix-the-footer-2");
    });

    it("refuses a rename with the Rust codes", async () => {
      const api = createMockWorkspace({ ...DEMO_WORKSPACE, remotes: { [FIRST]: { ahead: 0, behind: 0 } } });
      await expect(api.worktreeRenameBranch(FIRST, "x")).rejects.toMatchObject({ code: "branch_pushed" });
      await expect(api.worktreeRenameBranch("/nope", "x")).rejects.toMatchObject({ code: "worktree_unknown" });
      await expect(api.worktreeRenameBranch("/demo/xdev", "x")).rejects.toMatchObject({ code: "primary_worktree" });
      const plain = createMockWorkspace();
      await expect(plain.worktreeRenameBranch(FIRST, "...")).rejects.toMatchObject({ code: "bad_name" });
    });

    it("suggests from the first prompt seeded for the worktree, bad_name without one", async () => {
      const api = createMockWorkspace({ ...DEMO_WORKSPACE, prompts: { [FIRST]: "fix the footer usage meter rounding", "s-2": "add login page" } });
      expect(await api.worktreeSuggestBranch(FIRST, null)).toBe("fix-the-footer-usage");
      expect(await api.worktreeSuggestBranch(FIRST, "s-2")).toBe("add-login-page");
      await expect(api.worktreeSuggestBranch("/demo/wt/xdev-other", null)).rejects.toMatchObject({ code: "bad_name" });
    });

    it("shows the conflict state, marks its files in the stage state and clears on continue", async () => {
      const api = createMockWorkspace(CONFLICTED);
      expect(await api.worktreeConflicts(FIRST)).toMatchObject({ op: "rebase", files: ["src/session.ts"], step: [3, 7] });
      expect(await api.worktreeConflicts("/demo/xdev")).toBeNull();
      const conflicted = (await api.worktreeStageState(FIRST)).filter((s) => s.conflicted).map((s) => s.path);
      expect(conflicted).toEqual(["src/session.ts"]);
      await expect(api.worktreeConflictContinue(FIRST)).rejects.toMatchObject({ code: "still_conflicted" });
      await api.worktreeStage(FIRST, ["src/session.ts"], true);
      expect((await api.worktreeConflicts(FIRST))!.files).toEqual([]);
      expect((await api.worktreeStageState(FIRST)).some((s) => s.conflicted)).toBe(false);
      await api.worktreeConflictContinue(FIRST);
      expect(await api.worktreeConflicts(FIRST)).toBeNull();
      await expect(api.worktreeConflictContinue(FIRST)).rejects.toMatchObject({ code: "no_conflict" });
    });

    it("asks before an abort, and clears the state when confirmed", async () => {
      const api = createMockWorkspace(CONFLICTED);
      await expect(api.worktreeConflictAbort(FIRST, false)).rejects.toMatchObject({ code: "needs_approval" });
      expect(await api.worktreeConflicts(FIRST)).not.toBeNull();
      await api.worktreeConflictAbort(FIRST, true);
      expect(await api.worktreeConflicts(FIRST)).toBeNull();
      await expect(api.worktreeConflictAbort(FIRST, true)).rejects.toMatchObject({ code: "no_conflict" });
    });
  });

  describe("history and updates", () => {
    const ID = "a".repeat(40);
    const commit = (id: string, subject: string) => ({ id, parents: [], author: "A", email: "a@example.com", time: 1, subject, body: "", refs: [] });
    const log = {
      commits: [commit(ID, "newest"), commit("b".repeat(40), "middle"), commit("c".repeat(40), "oldest")],
      head: ID,
      branch: "oak",
      upstream: null,
      base: null,
      mergeBase: null,
      incoming: false,
      outgoing: false,
      hasMore: false,
    };
    const files = { id: ID, parent: null, files: [{ path: "a.ts", oldPath: null, status: "modified" as const, added: 1, removed: 0 }] };
    const seeded = () => createMockWorkspace({ repos: DEMO_WORKSPACE.repos, changes: {}, log: { [FIRST]: log }, commitFiles: { [`${FIRST}#${ID}`]: files }, hostless: ["/demo/xdev"] });

    it("pages the log and returns the files of a seeded commit", async () => {
      const api = seeded();
      const page = await api.worktreeLog(FIRST, 2, 0);
      expect(page.commits.map((c) => c.subject)).toEqual(["newest", "middle"]);
      expect(page.hasMore).toBe(true);
      expect((await api.worktreeLog(FIRST, 2, 2)).hasMore).toBe(false);
      expect((await api.worktreeCommitFiles(FIRST, ID)).files[0].path).toBe("a.ts");
      expect((await api.worktreeCommitFile(FIRST, ID, "a.ts")).skip).toBeNull();
      expect((await createMockWorkspace().worktreeLog(FIRST, 50, 0)).commits).toEqual([]);
    });

    it("refuses an unknown worktree, a bad id or file, and a repo without a web remote", async () => {
      const api = seeded();
      await expect(api.worktreeLog("/nope", 50, 0)).rejects.toMatchObject({ code: "worktree_unknown" });
      await expect(api.worktreeCommitFiles(FIRST, "--x")).rejects.toMatchObject({ code: "git" });
      await expect(api.worktreeCommitFile(FIRST, ID, "zz.ts")).rejects.toMatchObject({ code: "bad_arg" });
      await expect(api.worktreeOpenFileOnHost(FIRST, "../a", null, null)).rejects.toMatchObject({ code: "bad_arg" });
      await expect(api.worktreeOpenCommit("/demo/xdev", ID)).rejects.toMatchObject({ code: "no_web_remote" });
      await expect(api.worktreeOpenFileOnHost("/demo/xdev", "a.ts", null, null)).rejects.toMatchObject({ code: "no_web_remote" });
      await expect(api.worktreeOpenCommit(FIRST, ID)).resolves.toBeUndefined();
      await expect(api.worktreeOpenFileOnHost(FIRST, "a.ts", 1, 3)).resolves.toBeUndefined();
    });

    it("fast-forward moves the remote and refuses a split history", async () => {
      const behind = createMockWorkspace({ repos: DEMO_WORKSPACE.repos, changes: {}, remotes: { [FIRST]: { ahead: 0, behind: 2 } } });
      expect((await behind.worktreeFastForward(FIRST)).upstream).toMatchObject({ ahead: 0, behind: 0 });
      const split = createMockWorkspace({ repos: DEMO_WORKSPACE.repos, changes: {}, remotes: { [FIRST]: { ahead: 1, behind: 1 } } });
      await expect(split.worktreeFastForward(FIRST)).rejects.toMatchObject({ code: "pull_diverged" });
      await expect(createMockWorkspace().worktreeFastForward(FIRST)).rejects.toMatchObject({ code: "no_upstream" });
    });

    it("a pull follows the policy, and sync then pushes", async () => {
      const split = { ahead: 1, behind: 1 };
      const withPolicy = (pullPolicy: "ff-only" | "merge" | "rebase" | "git-config") =>
        createMockWorkspace({ repos: DEMO_WORKSPACE.repos, changes: {}, remotes: { [FIRST]: split }, git: { pullPolicy } });
      await expect(withPolicy("ff-only").worktreePull(FIRST)).rejects.toMatchObject({ code: "pull_diverged" });
      await expect(withPolicy("git-config").worktreePull(FIRST)).rejects.toMatchObject({ code: "pull_policy" });
      expect((await withPolicy("merge").worktreePull(FIRST)).upstream).toMatchObject({ ahead: 1, behind: 0 });
      expect((await withPolicy("rebase").worktreeSync(FIRST)).upstream).toMatchObject({ ahead: 0, behind: 0 });
    });

    it("a rewritten remote asks for a force push, and a rebase rewrites a pushed branch", async () => {
      const api = createMockWorkspace({ repos: DEMO_WORKSPACE.repos, changes: {}, remotes: { [FIRST]: { ahead: 1, behind: 1 } }, rewritten: { [FIRST]: true } });
      await expect(api.worktreeSync(FIRST)).rejects.toMatchObject({ code: "needs_force" });
      const view = await api.worktreeForcePush(FIRST, "b".repeat(40), true);
      expect(view.upstream).toMatchObject({ ahead: 0, behind: 0, rewritten: false });
      await expect(createMockWorkspace().worktreeRebaseFromBase(FIRST)).resolves.toMatchObject({ branch: expect.any(String) });
    });
  });
});
