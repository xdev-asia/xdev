import type { Api, ApiError, DirEntry, DirListing, RepoView, VaultView, WorktreeChange, WorktreeFileDiff, WorktreeStat, WorktreeView } from "./api";

type WorkspaceApi = Pick<
  Api,
  | "workspaceList"
  | "repoAdd"
  | "repoForget"
  | "repoUpdate"
  | "worktreeAdopt"
  | "vaultList"
  | "vaultAdd"
  | "vaultForget"
  | "vaultCreateDocs"
  | "worktreeCreate"
  | "worktreePin"
  | "worktreeRemove"
  | "worktreeChanges"
  | "worktreeFileDiff"
  | "worktreeCommit"
  | "worktreeStat"
  | "worktreeListDir"
>;

export type MockWorkspaceSeed = {
  repos: RepoView[];
  // Pending changes by worktree path.
  changes: Record<string, WorktreeChange[]>;
  // Worktrees made outside xDev, by repo id; they join `RepoView.found`.
  found?: Record<string, WorktreeView[]>;
  // Ids of the repos whose primary checkout has a `docs/` folder.
  docs?: string[];
  // Shared vault folders.
  vaults?: string[];
};

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
      worktreeRoot: "/demo/wt",
      missing: false,
      worktrees: [
        worktree("/demo/xdev", "xdev", "main", true),
        worktree("/demo/wt/xdev-oak", "oak", "oak", false),
        worktree("/demo/wt/xdev-elm", "elm", "elm", false),
      ],
      found: [],
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

// R3: 1-40 characters, `[a-z0-9]` first, then `[a-z0-9._-]`.
const SHORT_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

function trimPath(path: string): string {
  return path.trim().replace(/[\\/]+$/, "");
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

// Whether `path` is `base` or lies under it.
function within(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

function folderName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
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
  for (const repo of repos) repo.found = structuredClone(seed.found?.[repo.id] ?? repo.found);
  const docs = new Set(seed.docs ?? []);
  const shared: string[] = [...(seed.vaults ?? [])];

  function repoVault(repo: RepoView): VaultView {
    return { id: `repo:${repo.id}`, kind: "repo", path: `${repo.path}/docs`, name: repo.shortName, repoId: repo.id, exists: docs.has(repo.id) };
  }

  function sharedVault(path: string): VaultView {
    return { id: `shared:${path}`, kind: "shared", path, name: folderName(path), repoId: null, exists: true };
  }

  function vaults(): VaultView[] {
    // Shared ones by name, as Rust lists them.
    const named = shared.map(sharedVault).sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()) || x.path.localeCompare(y.path));
    return [...repos.map(repoVault), ...named];
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
        worktreeRoot: `${root.replace(/[\/][^\/]*$/, "")}/wt`,
        missing: false,
        worktrees: [worktree(root, shortName, "main", true)],
        found: [],
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
    async repoUpdate(id, patch) {
      const repo = repos.find((r) => r.id === id);
      if (!repo) return reject("repo_unknown", id);
      const { shortName, baseRef, worktreeRoot } = patch;
      if (shortName !== undefined) {
        if (!SHORT_NAME.test(shortName)) return reject("bad_name", shortName);
        if (repos.some((r) => r.id !== id && r.shortName === shortName)) return reject("short_name_taken", shortName);
      }
      if (baseRef !== undefined && (baseRef.trim() === "" || /\s|\.\.|^-/.test(baseRef))) return reject("bad_ref", baseRef);
      if (worktreeRoot !== undefined && (!isAbsolute(worktreeRoot) || within(trimPath(worktreeRoot), repo.path))) {
        return reject("bad_path", worktreeRoot);
      }
      if (shortName !== undefined) repo.shortName = shortName;
      if (baseRef !== undefined) repo.baseRef = baseRef;
      if (worktreeRoot !== undefined) repo.worktreeRoot = trimPath(worktreeRoot);
      return structuredClone(repo);
    },
    async worktreeAdopt(path) {
      if (repos.some((r) => r.path === path)) return reject("primary_worktree", path);
      if (findWorktree(path)) return reject("worktree_exists", path);
      for (const repo of repos) {
        const wt = repo.found.find((w) => w.path === path);
        if (!wt) continue;
        repo.found = repo.found.filter((w) => w !== wt);
        const adopted: WorktreeView = { ...wt, start: wt.head, pinned: false };
        repo.worktrees.push(adopted);
        return structuredClone(adopted);
      }
      return reject("worktree_unknown", path);
    },
    async vaultList() {
      return vaults();
    },
    async vaultAdd(path) {
      const root = trimPath(path);
      if (!isAbsolute(root)) return reject("bad_path", path);
      if (vaults().some((v) => v.path === root)) return reject("vault_exists", root);
      shared.push(root);
      return sharedVault(root);
    },
    async vaultForget(id) {
      const i = shared.findIndex((p) => sharedVault(p).id === id);
      if (i < 0) return reject("vault_unknown", id);
      shared.splice(i, 1);
    },
    async vaultCreateDocs(repoId, file, content) {
      void content;
      const repo = repos.find((r) => r.id === repoId);
      if (!repo) return reject("repo_unknown", repoId);
      if (/[/\\:]/.test(file) || file.length <= 3 || !file.endsWith(".md")) return reject("bad_path", file);
      docs.add(repo.id);
      return repoVault(repo);
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
      changes.set(path, rest);
      commits += 1;
      return commits.toString(16).padStart(40, "a");
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
