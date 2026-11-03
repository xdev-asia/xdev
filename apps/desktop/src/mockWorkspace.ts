import type { Api, ApiError, Check, Commit, DirEntry, DirListing, RepoView, PrDraft, PrView, ShipView, WorktreeChange, WorktreeFileDiff, WorktreeStat, WorktreeView } from "./api";

type WorkspaceApi = Pick<
  Api,
  | "workspaceList"
  | "repoAdd"
  | "repoForget"
  | "worktreeCreate"
  | "worktreePin"
  | "worktreeRemove"
  | "worktreeChanges"
  | "worktreeFileDiff"
  | "worktreeCommit"
  | "worktreeStat"
  | "worktreeShip"
  | "worktreePush"
  | "worktreePull"
  | "worktreeSync"
  | "worktreeFetch"
  | "worktreeForcePush"
  | "worktreeAmend"
  | "worktreePr"
  | "worktreePrCreate"
  | "worktreePrChecks"
  | "worktreePrOpen"
  | "worktreeDraftCommit"
  | "worktreeDraftPr"
  | "worktreeListDir"
>;

export type MockWorkspaceSeed = {
  repos: RepoView[];
  // Pending changes by worktree path.
  changes: Record<string, WorktreeChange[]>;
  // Pull requests and their checks by worktree path.
  prs?: Record<string, PrView>;
  checks?: Record<string, Check[]>;
  // The next commit or amend in that worktree is rejected with `hook_failed`; the text is the hook output.
  hookFailure?: Record<string, string>;
  // Worktrees that already track a remote branch, with how far they have drifted.
  remotes?: Record<string, { ahead: number; behind: number }>;
};

// The fake remote of one worktree.
type Remote = { tracked: boolean; ahead: number; behind: number; commits: Commit[] };

const DEMO_START = "5555555555555555555555555555555555555555";

function worktree(path: string, name: string, branch: string, primary: boolean): WorktreeView {
  return { path, name, branch, head: DEMO_START, start: primary ? null : DEMO_START, primary, pinned: false, detached: false };
}

export const DEMO_WORKSPACE: MockWorkspaceSeed = {
  repos: [
    {
      id: "demo-xdev",
      shortName: "xdev",
      path: "/demo/xdev",
      baseRef: "main",
      missing: false,
      worktrees: [
        worktree("/demo/xdev", "xdev", "main", true),
        worktree("/demo/wt/xdev-oak", "oak", "oak", false),
        worktree("/demo/wt/xdev-elm", "elm", "elm", false),
      ],
    },
  ],
  changes: {
    "/demo/wt/xdev-oak": [
      { path: "docs/old-notes.md", kind: "deleted" },
      { path: "src/session.ts", kind: "modified" },
      { path: "src/status.ts", kind: "added" },
    ],
  },
};

// Files every demo worktree has on disk, before its own changes.
const DEMO_FILES = ["README.md", "package.json", "src/App.tsx", "src/lib/format.ts", "src/main.tsx", "src/session.ts", "docs/guide.md", "docs/old-notes.md"];
const LIST_CAP = 2000;

// What the worktree holds on disk: the base files, plus added files, minus deleted ones.
function demoFiles(pending: WorktreeChange[]): string[] {
  const gone = new Set(pending.filter((c) => c.kind === "deleted").map((c) => c.path));
  const added = pending.filter((c) => c.kind === "added").map((c) => c.path);
  return [...new Set([...DEMO_FILES, ...added])].filter((f) => !gone.has(f));
}

function demoListing(files: string[], dir: string): DirListing | null {
  const prefix = dir === "" ? "" : `${dir}/`;
  const found = new Map<string, DirEntry>();
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const [name, ...rest] = file.slice(prefix.length).split("/");
    found.set(name, { name, dir: rest.length > 0 });
  }
  if (dir !== "" && found.size === 0) return null;
  const entries = [...found.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { entries: entries.slice(0, LIST_CAP), truncated: entries.length > LIST_CAP };
}

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

// Like the Rust `slug`: lowercase, spaces as `-`, only `[a-z0-9._/-]`, no leading `-` or `.`.
function slug(name: string): string {
  return [...name.toLowerCase()]
    .map((c) => (/\s/.test(c) ? "-" : c))
    .filter((c) => /[a-z0-9._/-]/.test(c))
    .join("")
    .replace(/^[-.]+/, "")
    .slice(0, 48);
}

// Fixed line counts per kind, so the demo rows show numbers that follow the pending changes.
function demoStat(pending: WorktreeChange[]): WorktreeStat {
  const lines = { added: [3, 0], modified: [1, 1], deleted: [0, 2] } as const;
  const stat: WorktreeStat = { files: pending.length, added: 0, removed: 0 };
  for (const { kind } of pending) {
    stat.added += lines[kind][0];
    stat.removed += lines[kind][1];
  }
  return stat;
}

const WORDS = ["birch", "cedar", "fir", "maple", "pine", "willow"];

function demoDiff(file: string, kind: WorktreeChange["kind"]): WorktreeFileDiff {
  if (/\.(png|jpe?g|gif|ico)$/i.test(file)) return { old: null, new: null, skip: "binary" };
  const old = `// ${file}\nexport const value = 1;\n`;
  const next = `// ${file}\nexport const value = 2;\n`;
  return { old: kind === "added" ? null : old, new: kind === "deleted" ? null : next, skip: null };
}

// In-memory workspace that follows the Rust commands: the same error codes and the same gate on
// removing a worktree. Nothing is read from disk, so a new repo is only its primary checkout.
export function createMockWorkspace(seed: MockWorkspaceSeed = DEMO_WORKSPACE): WorkspaceApi {
  const repos: RepoView[] = structuredClone(seed.repos);
  const changes = new Map<string, WorktreeChange[]>(Object.entries(structuredClone(seed.changes)));
  let commits = 0;
  let prNumber = 0;
  const prs = new Map<string, PrView>(Object.entries(structuredClone(seed.prs ?? {})));
  const checks = new Map<string, Check[]>(Object.entries(structuredClone(seed.checks ?? {})));
  const hooks = new Map<string, string>(Object.entries(seed.hookFailure ?? {}));
  const remotes = new Map<string, Remote>();

  function remoteOf(path: string): Remote {
    let r = remotes.get(path);
    if (!r) {
      const seeded = seed.remotes?.[path];
      r = { tracked: seeded !== undefined, ahead: seeded?.ahead ?? 0, behind: seeded?.behind ?? 0, commits: [] };
      remotes.set(path, r);
    }
    return r;
  }

  function commitId(): string {
    commits += 1;
    return commits.toString(16).padStart(40, "a");
  }

  function shipView(path: string): ShipView | Promise<never> {
    const found = findWorktree(path);
    if (!found) return reject("worktree_unknown", path);
    const { wt, repo } = found;
    const r = remoteOf(path);
    const branch = wt.detached ? null : wt.branch;
    const upstream =
      r.tracked && branch !== null
        ? { remote: "origin", branch, id: "b".repeat(40), ahead: r.ahead, behind: r.behind }
        : null;
    return {
      branch,
      base: repo.baseRef,
      remote: "origin",
      upstream,
      headPushed: upstream !== null && r.ahead === 0,
      atStart: r.commits.length === 0,
      range: wt.primary ? null : { mergeBase: DEMO_START, added: r.commits.length * 3, removed: 0, commits: structuredClone(r.commits), truncated: false },
    };
  }

  // Shared by push and sync: a push is rejected when the remote is ahead of us.
  function doPush(path: string): ShipView | Promise<never> {
    const view = shipView(path);
    if (view instanceof Promise) return view;
    if (view.branch === null) return reject("detached");
    const r = remoteOf(path);
    if (r.tracked && r.behind > 0) return reject("push_rejected", "non-fast-forward");
    r.tracked = true;
    r.ahead = 0;
    return shipView(path);
  }

  function doPull(path: string): ShipView | Promise<never> {
    const view = shipView(path);
    if (view instanceof Promise) return view;
    const r = remoteOf(path);
    if (!r.tracked) return reject("no_upstream");
    if (r.behind > 0 && r.ahead > 0) return reject("pull_diverged");
    r.behind = 0;
    return shipView(path);
  }

  function takeHook(path: string): Promise<never> | null {
    const out = hooks.get(path);
    if (out === undefined) return null;
    hooks.delete(path);
    return reject("hook_failed", out);
  }

  function findWorktree(path: string): { repo: RepoView; wt: WorktreeView } | undefined {
    for (const repo of repos) {
      const wt = repo.worktrees.find((w) => w.path === path);
      if (wt) return { repo, wt };
    }
    return undefined;
  }

  return {
    async workspaceList() {
      return structuredClone(repos);
    },
    async repoAdd(path) {
      const root = path.trim().replace(/[\/]+$/, "");
      if (root === "") return reject("no_repo");
      if (repos.some((r) => r.path === root)) return reject("repo_exists", root);
      const base = (root.split(/[\/]/).pop() ?? root).toLowerCase().replace(/[^a-z0-9._-]/g, "");
      let shortName = base;
      for (let n = 2; repos.some((r) => r.shortName === shortName); n++) shortName = `${base}-${n}`;
      const repo: RepoView = {
        id: `repo-${repos.length + 1}-${shortName}`,
        shortName,
        path: root,
        baseRef: "main",
        missing: false,
        worktrees: [worktree(root, shortName, "main", true)],
      };
      repos.push(repo);
      return structuredClone(repo);
    },
    async repoForget(id) {
      const i = repos.findIndex((r) => r.id === id);
      if (i < 0) return reject("repo_unknown", id);
      for (const wt of repos[i].worktrees) changes.delete(wt.path);
      repos.splice(i, 1);
    },
    async worktreeCreate(repoId, name, from) {
      const repo = repos.find((r) => r.id === repoId);
      if (!repo) return reject("repo_unknown", repoId);
      const typed = name.trim();
      const branch =
        typed === "" ? (WORDS.find((w) => !repo.worktrees.some((x) => x.branch === w)) ?? `wt-${repo.worktrees.length}`) : slug(typed);
      if (branch === "" || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) return reject("bad_name", typed);
      if (repo.worktrees.some((w) => w.branch === branch)) return reject("branch_exists", branch);
      if (from !== null && from.trim() !== "" && /\s|\.\.|^-/.test(from.trim())) return reject("bad_ref", from.trim());
      const folder = branch.replace(/\//g, "-");
      const parent = repo.path.replace(/[\/][^\/]*$/, "");
      const wt = worktree(`${parent}/wt/${repo.shortName}-${folder}`, folder, branch, false);
      repo.worktrees.push(wt);
      return structuredClone(wt);
    },
    async worktreePin(path, pinned) {
      const found = findWorktree(path);
      if (!found || found.wt.primary) return reject("worktree_unknown", path);
      found.wt.pinned = pinned;
    },
    async worktreeRemove(path, force, confirmed) {
      if (!confirmed) return reject("needs_approval", `remove ${path}`);
      const found = findWorktree(path);
      if (!found) return reject("worktree_unknown", path);
      if (found.wt.primary) return reject("primary_worktree", path);
      if (!force && (changes.get(path)?.length ?? 0) > 0) return reject("worktree_dirty", path);
      found.repo.worktrees = found.repo.worktrees.filter((w) => w !== found.wt);
      changes.delete(path);
    },
    async worktreeChanges(path) {
      const found = findWorktree(path);
      if (!found || found.wt.primary) return reject("worktree_unknown", path);
      return structuredClone(changes.get(path) ?? []);
    },
    async worktreeFileDiff(path, file) {
      const found = findWorktree(path);
      if (!found || found.wt.primary) return reject("worktree_unknown", path);
      const change = changes.get(path)?.find((c) => c.path === file);
      if (!change) return reject("bad_arg", file);
      return demoDiff(file, change.kind);
    },
    async worktreeCommit(path, files, message) {
      const found = findWorktree(path);
      if (!found || found.wt.primary) return reject("worktree_unknown", path);
      if (message.trim() === "") return reject("empty_message");
      const pending = changes.get(path) ?? [];
      const rest = pending.filter((c) => !files.includes(c.path));
      if (rest.length === pending.length) return null;
      const hook = takeHook(path);
      if (hook) return hook;
      changes.set(path, rest);
      const id = commitId();
      const r = remoteOf(path);
      r.commits.unshift({ id, author: "demo", time: 1_700_000_000 + commits, message: message.trim().split("\n")[0] });
      if (r.tracked) r.ahead += 1;
      return id;
    },
    async worktreeShip(path) {
      return shipView(path);
    },
    async worktreePush(path) {
      return doPush(path);
    },
    async worktreePull(path) {
      return doPull(path);
    },
    async worktreeSync(path) {
      const pulled = doPull(path);
      if (pulled instanceof Promise) return pulled;
      return doPush(path);
    },
    async worktreeFetch(path) {
      return shipView(path);
    },
    async worktreeForcePush(path, _expected, confirmed) {
      if (!confirmed) return reject("needs_approval", `force push ${path}`);
      const view = shipView(path);
      if (view instanceof Promise) return view;
      if (view.upstream === null) return reject("no_upstream");
      if (view.branch === view.base) return reject("force_base", view.branch ?? "");
      const r = remoteOf(path);
      r.ahead = 0;
      r.behind = 0;
      return shipView(path);
    },
    async worktreeAmend(path, files, message, confirmed) {
      const found = findWorktree(path);
      if (!found || found.wt.primary) return reject("worktree_unknown", path);
      if (message.trim() === "") return reject("empty_message");
      const r = remoteOf(path);
      if (r.commits.length === 0) return reject("nothing_to_amend");
      const pushed = r.tracked && r.ahead === 0;
      if (pushed && !confirmed) return reject("amend_pushed");
      const hook = takeHook(path);
      if (hook) return hook;
      const pending = changes.get(path) ?? [];
      changes.set(path, pending.filter((c) => !files.includes(c.path)));
      const id = commitId();
      r.commits[0] = { ...r.commits[0], id, message: message.trim().split("\n")[0] };
      if (pushed) {
        // The rewritten commit is no longer the remote's: both sides now hold one the other lacks.
        r.ahead = 1;
        r.behind = 1;
      }
      return id;
    },
    async worktreePr(path) {
      if (!findWorktree(path)) return reject("worktree_unknown", path);
      return structuredClone(prs.get(path) ?? null);
    },
    async worktreePrCreate(path, draft) {
      const view = shipView(path);
      if (view instanceof Promise) return view;
      if (view.branch === null) return reject("detached");
      if (!view.headPushed) return reject("not_pushed");
      if (draft.title.trim() === "") return reject("empty_title");
      prNumber += 1;
      const pr: PrView = {
        number: prNumber,
        url: `https://example.test/pull/${prNumber}`,
        state: draft.draft ? "draft" : "open",
        title: draft.title,
        base: draft.base,
        head: view.branch,
      };
      prs.set(path, pr);
      return structuredClone(pr);
    },
    async worktreePrChecks(path, number) {
      if (!findWorktree(path)) return reject("worktree_unknown", path);
      return prs.get(path)?.number === number ? structuredClone(checks.get(path) ?? []) : [];
    },
    async worktreePrOpen(path) {
      if (!findWorktree(path)) return reject("worktree_unknown", path);
      if (!prs.has(path)) return reject("not_pushed");
    },
    async worktreeDraftCommit(path, files) {
      if (!findWorktree(path)) return reject("worktree_unknown", path);
      return `Update ${files.length} ${files.length === 1 ? "file" : "files"}`;
    },
    async worktreeDraftPr(path) {
      const found = findWorktree(path);
      if (!found) return reject("worktree_unknown", path);
      const subject = remoteOf(path).commits[0]?.message ?? found.wt.branch;
      return { base: found.repo.baseRef, title: subject, body: `Changes from ${found.wt.branch}.`, draft: false };
    },
    async worktreeStat(path) {
      const found = findWorktree(path);
      if (!found) return reject("worktree_unknown", path);
      return demoStat(found.wt.primary ? [] : (changes.get(path) ?? []));
    },
    async worktreeListDir(path, dir) {
      if (!findWorktree(path)) return reject("worktree_unknown", path);
      const plain = dir.split("/").every((part) => part !== ".." && part !== ".git" && !part.includes(":"));
      if (dir.startsWith("/") || !plain) return reject("bad_path", dir);
      const rel = dir.split("/").filter((part) => part !== "" && part !== ".").join("/");
      const listing = demoListing(demoFiles(changes.get(path) ?? []), rel);
      return listing ? structuredClone(listing) : reject("not_found", dir);
    },
  };
}
