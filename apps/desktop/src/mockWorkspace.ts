import { normalizePrefix, previewPrefix } from "./settings/branchPrefix";
import type { SettingsEmit } from "./mockSettings";
import { DEFAULT_GIT_SETTINGS } from "./settings/gitDefaults";
import { createMockFiles, mockHash, type MockFiles } from "./mockFiles";
import type { Api, ApiError, Check, Commit, DirEntry, DirListing, FileCommand, FileCommands, GitSettings, HookKind, HookScript, RepoHooks, RepoView, ReviewNote, VaultView, PrDraft, PrView, ShipView, WorktreeChange, WorktreeFileDiff, WorktreeStat, WorktreeView } from "./api";

type WorkspaceApi = Pick<
  Api,
  | "workspaceList"
  | "repoAdd"
  | "repoForget"
  | "repoUpdate"
  | "repoHooks"
  | "repoHookTrust"
  | "repoFileCommands"
  | "repoFileCommandsTrust"
  | "worktreeArchiveRun"
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
  | "worktreeCheckLog"
  | "worktreeDraftCommit"
  | "worktreeDraftPr"
  | "worktreeListDir"
  | "worktreeReview"
  | "worktreeReviewFile"
  | "worktreeStage"
  | "worktreeBranches"
  | "worktreeStageState"
  | "worktreeDiscard"
  | "reviewNotes"
  | "reviewNotesPut"
  | "gitSettings"
  | "setGitSettings"
  | "gitUserName"
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
  // Pull requests and their checks by worktree path.
  prs?: Record<string, PrView>;
  checks?: Record<string, Check[]>;
  // The next commit or amend in that worktree is rejected with `hook_failed`; the text is the hook output.
  hookFailure?: Record<string, string>;
  // Worktrees that already track a remote branch, with how far they have drifted.
  remotes?: Record<string, { ahead: number; behind: number }>;
  // The global git `user.name`; none by default, so the git-username prefix adds nothing.
  gitUserName?: string | null;
  // Settings → Git; the app's defaults when left out.
  git?: Partial<GitSettings>;
  // `xdev.toml` by worktree path; a worktree without one falls back to its repo's primary path.
  repoFiles?: Record<string, MockRepoFile>;
};

// A worktree's `xdev.toml` and what its scripts do when run; nothing is executed.
export type MockRepoFile = {
  setup?: string;
  archive?: string;
  waitForSetup?: boolean;
  // The file does not parse: no shared scripts, this text as `parseError`.
  parseError?: string;
  // The setup command guessed from the files, offered when there is no setup.
  detected?: string;
  // Exit codes and output of the scripts; 0 and empty by default.
  setupCode?: number;
  archiveCode?: number;
  archiveOutput?: string;
  // The valid `[[commands]]` entries, and one line per entry left out.
  commands?: FileCommand[];
  commandErrors?: string[];
};

// What the mock terminal of `SETUP_PROFILE` prints and exits with.
export type MockSetupRun = { text: string; code: number };

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
      worktreeRoot: "/demo/wt",
      setupPolicy: "ask",
      scriptSource: "auto",
      localSetup: "",
      localArchive: "",
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

// `dirs` holds every folder, also the empty ones a create left.
function demoListing(files: string[], dirs: Set<string>, dir: string): DirListing | null {
  if (dir !== "" && !dirs.has(dir)) return null;
  const prefix = dir === "" ? "" : `${dir}/`;
  const found = new Map<string, DirEntry>();
  for (const path of [...files, ...dirs]) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...rest] = path.slice(prefix.length).split("/");
    found.set(name, { name, dir: rest.length > 0 || dirs.has(path) });
  }
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

const REVIEW_BRANCHES = [
  { name: "main", remote: false },
  { name: "develop", remote: false },
  { name: "origin/main", remote: true },
];

// The Rust store's checks, so the mock refuses what the real one refuses.
function firstBadNote(notes: ReviewNote[]): string | null {
  if (notes.length > 500) return "too many notes";
  const seen = new Set<string>();
  for (const n of notes) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(n.id)) return `bad id ${n.id}`;
    if (seen.has(n.id)) return `duplicate id ${n.id}`;
    seen.add(n.id);
    if (n.startLine < 1 || n.startLine > n.line) return `bad lines in ${n.id}`;
    const plain = n.file !== "" && !/[\:]/.test(n.file) && !n.file.startsWith("/") && n.file.split("/").every((p) => p !== "" && p !== "." && p !== "..");
    if (!plain) return `bad file in ${n.id}`;
    if (n.body.trim() === "" || n.body.length > 20_000) return `bad body in ${n.id}`;
    if (n.anchor.length > 4_000) return `anchor too long in ${n.id}`;
  }
  return null;
}

const WORDS = ["birch", "cedar", "fir", "maple", "pine", "willow"];

export { DEFAULT_GIT_SETTINGS };

function demoDiff(file: string, kind: WorktreeChange["kind"]): WorktreeFileDiff {
  if (/\.(png|jpe?g|gif|ico)$/i.test(file)) return { old: null, new: null, skip: "binary" };
  const old = `// ${file}\nexport const value = 1;\n`;
  const next = `// ${file}\nexport const value = 2;\n`;
  return { old: kind === "added" ? null : old, new: kind === "deleted" ? null : next, skip: null };
}

// In-memory workspace that follows the Rust commands: the same error codes and the same gate on
// removing a worktree. Nothing is read from disk, so a new repo is only its primary checkout.
export function createMockWorkspace(
  seed: MockWorkspaceSeed = DEMO_WORKSPACE,
  emit: SettingsEmit = () => {},
): WorkspaceApi & Omit<MockFiles, "tree"> & { __setupRun(cwd: string): Promise<MockSetupRun> } {
  const repos: RepoView[] = structuredClone(seed.repos);
  const changes = new Map<string, WorktreeChange[]>(Object.entries(structuredClone(seed.changes)));
  let commits = 0;
  for (const repo of repos) repo.found = structuredClone(seed.found?.[repo.id] ?? repo.found);
  const docs = new Set(seed.docs ?? []);
  const shared: string[] = [...(seed.vaults ?? [])];
  let git: GitSettings = { ...DEFAULT_GIT_SETTINGS, ...seed.git };
  const userName = seed.gitUserName ?? null;

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
  let prNumber = 0;
  const prs = new Map<string, PrView>(Object.entries(structuredClone(seed.prs ?? {})));
  const checks = new Map<string, Check[]>(Object.entries(structuredClone(seed.checks ?? {})));
  const hooks = new Map<string, string>(Object.entries(seed.hookFailure ?? {}));
  const remotes = new Map<string, Remote>();
  const stagedFiles = new Map<string, Set<string>>();
  const notes = new Map<string, ReviewNote[]>();

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
    // Against the upstream only the unpushed commits count; they are the newest, first in the list.
    const vsUpstream = git.compareAgainstUpstream && upstream !== null;
    const counted = vsUpstream ? r.commits.slice(0, r.ahead) : r.commits;
    return {
      branch,
      base: repo.baseRef,
      remote: "origin",
      upstream,
      headPushed: upstream !== null && r.ahead === 0,
      atStart: r.commits.length === 0,
      range: wt.primary ? null : { mergeBase: DEMO_START, added: counted.length * 3, removed: 0, commits: structuredClone(counted), truncated: false },
      rangeBase: vsUpstream ? `origin/${upstream.branch}` : repo.baseRef,
      aheadOfBase: !wt.primary && r.commits.length > 0,
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

  const repoFiles = new Map<string, MockRepoFile>(Object.entries(structuredClone(seed.repoFiles ?? {})));
  const trusted = new Set<string>();

  // Shared, then a newline, then local, as the repo's script source says.
  function scriptOf(repo: RepoView, kind: HookKind, shared: string, local: string): HookScript | null {
    const source = repo.scriptSource === "auto" ? (local.trim() !== "" ? "local" : "shared") : repo.scriptSource;
    const sharedPart = source === "local" ? "" : shared.trim() === "" ? "" : shared;
    const localPart = source === "shared" ? "" : local.trim() === "" ? "" : local;
    if (sharedPart === "" && localPart === "") return null;
    const text = sharedPart && localPart ? `${sharedPart}\n${localPart}` : sharedPart || localPart;
    const hash = sharedPart ? mockHash(sharedPart) : "";
    return { text, shared: sharedPart !== "", hash, trusted: hash === "" || trusted.has(`${repo.id}:${kind}:${hash}`) };
  }

  function hooksOf(path: string): { repo: RepoView; file: MockRepoFile | undefined; hooks: RepoHooks } | null {
    const found = findWorktree(path);
    if (!found) return null;
    const { repo } = found;
    const file = repoFiles.get(path) ?? repoFiles.get(repo.path);
    const parsed = file !== undefined && file.parseError === undefined ? file : undefined;
    const setup = scriptOf(repo, "setup", parsed?.setup ?? "", repo.localSetup);
    const archive = scriptOf(repo, "archive", parsed?.archive ?? "", repo.localArchive);
    return {
      repo,
      file,
      hooks: {
        setup,
        archive,
        waitForSetup: parsed?.waitForSetup ?? false,
        policy: repo.setupPolicy,
        parseError: file?.parseError ?? null,
        detected: setup === null ? (file?.detected ?? null) : null,
      },
    };
  }

  // Like `repo_file_commands`: listed even when untrusted; none when the file does not parse.
  function commandsOf(repo: RepoView, file: MockRepoFile | undefined): FileCommands {
    if (file?.parseError !== undefined) return { trusted: false, hash: "", commands: [], errors: [file.parseError] };
    const commands = structuredClone(file?.commands ?? []);
    const errors = [...(file?.commandErrors ?? [])];
    const hash = commands.length > 0 ? mockHash(JSON.stringify(commands)) : "";
    return { trusted: hash !== "" && trusted.has(`${repo.id}:commands:${hash}`), hash, commands, errors };
  }

  function findWorktree(path: string): { repo: RepoView; wt: WorktreeView } | undefined {
    for (const repo of repos) {
      const wt = repo.worktrees.find((w) => w.path === path);
      if (wt) return { repo, wt };
    }
    return undefined;
  }

  const { tree, ...files } = createMockFiles((path) => (findWorktree(path) ? demoFiles(changes.get(path) ?? []) : null));

  return {
    ...files,
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
        setupPolicy: "ask",
        scriptSource: "auto",
        localSetup: "",
        localArchive: "",
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
      if (patch.setupPolicy !== undefined) repo.setupPolicy = patch.setupPolicy;
      if (patch.scriptSource !== undefined) repo.scriptSource = patch.scriptSource;
      if (patch.localSetup !== undefined) repo.localSetup = patch.localSetup;
      if (patch.localArchive !== undefined) repo.localArchive = patch.localArchive;
      return structuredClone(repo);
    },
    async repoHooks(path) {
      const found = hooksOf(path);
      if (!found) return reject("worktree_unknown", path);
      return found.hooks;
    },
    async repoHookTrust(path, kind, hash) {
      const found = hooksOf(path);
      if (!found) return reject("worktree_unknown", path);
      const script = kind === "setup" ? found.hooks.setup : found.hooks.archive;
      if (!script || !script.shared || script.hash !== hash) return reject("hook_untrusted", kind);
      trusted.add(`${found.repo.id}:${kind}:${hash}`);
      return hooksOf(path)!.hooks;
    },
    async repoFileCommands(path) {
      const found = hooksOf(path);
      if (!found) return reject("worktree_unknown", path);
      return commandsOf(found.repo, found.file);
    },
    async repoFileCommandsTrust(path, hash) {
      const found = hooksOf(path);
      if (!found) return reject("worktree_unknown", path);
      const now = commandsOf(found.repo, found.file);
      if (now.hash === "" || now.hash !== hash) return reject("hook_untrusted", "commands");
      trusted.add(`${found.repo.id}:commands:${hash}`);
      return commandsOf(found.repo, found.file);
    },
    async worktreeArchiveRun(path) {
      const found = hooksOf(path);
      if (!found) return reject("worktree_unknown", path);
      const script = found.hooks.archive;
      if (!script) return { ran: false, code: null, output: "" };
      if (!script.trusted) return reject("hook_untrusted", "archive");
      return { ran: true, code: found.file?.archiveCode ?? 0, output: found.file?.archiveOutput ?? "" };
    },
    async __setupRun(cwd) {
      const found = hooksOf(cwd);
      if (!found) return reject("worktree_unknown", cwd);
      if (found.hooks.policy === "skip") return reject("setup_skipped");
      const script = found.hooks.setup;
      if (!script) return reject("hook_none", "setup");
      if (!script.trusted) return reject("hook_untrusted", "setup");
      return { text: script.text, code: found.file?.setupCode ?? 0 };
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
    async gitSettings() {
      return { ...git };
    },
    async setGitSettings(next) {
      git = { ...next, branchPrefixCustom: normalizePrefix(next.branchPrefixCustom) };
      emit(["git"]);
      return { ...git };
    },
    async gitUserName() {
      return userName;
    },
    async worktreeCreate(repoId, name, from) {
      const repo = repos.find((r) => r.id === repoId);
      if (!repo) return reject("repo_unknown", repoId);
      // As `create_worktree_with`: the prefix names the branch, the folder keeps only the leaf.
      const preview = previewPrefix(git, userName);
      if (preview.kind === "invalid") return reject("bad_branch_prefix", normalizePrefix(git.branchPrefixCustom));
      const prefixed = (leaf: string) => (preview.kind === "prefix" ? `${preview.prefix}/${leaf}` : leaf);
      const typed = name.trim();
      const leaf =
        typed === ""
          ? (WORDS.find((w) => !repo.worktrees.some((x) => x.branch === prefixed(w))) ?? `wt-${repo.worktrees.length}`)
          : slug(typed);
      const branch = prefixed(leaf);
      if (leaf === "" || leaf.includes("..") || leaf.endsWith("/") || leaf.endsWith(".lock")) return reject("bad_name", typed);
      if (repo.worktrees.some((w) => w.branch === branch)) return reject("branch_exists", branch);
      if (from !== null && from.trim() !== "" && /\s|\.\.|^-/.test(from.trim())) return reject("bad_ref", from.trim());
      const folder = leaf.replace(/\//g, "-");
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
    async worktreeReview(path, base) {
      const found = findWorktree(path);
      if (!found) return reject("worktree_unknown", path);
      let ref: { kind: "start" | "ref"; name: string | null; id: string };
      if (base === null) {
        ref = { kind: "start", name: null, id: DEMO_START };
      } else {
        const name = base.trim();
        const hex = /^[0-9a-f]{4,40}$/i.test(name);
        if (name === "" || name.startsWith("-") || !(hex || REVIEW_BRANCHES.some((b) => b.name === name))) return reject("bad_ref", name);
        ref = { kind: "ref", name, id: hex ? name.toLowerCase().padEnd(40, "0") : DEMO_START };
      }
      const pending = changes.get(path) ?? [];
      const files = pending.map((c) => {
        const staged = stagedFiles.get(path)?.has(c.path) ?? false;
        return { path: c.path, kind: c.kind, staged, unstaged: !staged };
      });
      return { base: ref, branch: found.wt.branch, baseRef: found.repo.baseRef, files };
    },
    async worktreeReviewFile(path, base, file) {
      const found = findWorktree(path);
      if (!found) return reject("worktree_unknown", path);
      if (!/^[0-9a-f]{4,64}$/i.test(base)) return reject("bad_ref", base);
      const change = changes.get(path)?.find((c) => c.path === file);
      if (!change) return reject("bad_arg", file);
      return demoDiff(file, change.kind);
    },
    async worktreeStage(path, files, staged) {
      if (!findWorktree(path)) return reject("worktree_unknown", path);
      const pending = changes.get(path) ?? [];
      for (const f of files) if (!pending.some((c) => c.path === f)) return reject("bad_arg", f);
      const set = stagedFiles.get(path) ?? new Set<string>();
      for (const f of files) {
        if (staged) set.add(f);
        else set.delete(f);
      }
      stagedFiles.set(path, set);
    },
    async worktreeStageState(path) {
      if (!findWorktree(path)) return reject("worktree_unknown", path);
      return (changes.get(path) ?? []).map((c) => {
        const staged = stagedFiles.get(path)?.has(c.path) ?? false;
        return { path: c.path, staged, unstaged: !staged, untracked: !staged && c.kind === "added" };
      });
    },
    async worktreeDiscard(path, files, stagedToo, confirmed) {
      if (!confirmed) return reject("needs_approval", `discard ${files.length} file(s)`);
      if (!findWorktree(path)) return reject("worktree_unknown", path);
      const pending = changes.get(path) ?? [];
      for (const f of files) if (!pending.some((c) => c.path === f)) return reject("bad_arg", f);
      const set = stagedFiles.get(path) ?? new Set<string>();
      // A staged file keeps its staged version unless the staged edits go too.
      const gone = files.filter((f) => !set.has(f) || stagedToo);
      for (const f of gone) set.delete(f);
      stagedFiles.set(path, set);
      changes.set(path, pending.filter((c) => !gone.includes(c.path)));
    },
    async worktreeBranches(path) {
      if (!findWorktree(path)) return reject("worktree_unknown", path);
      return structuredClone(REVIEW_BRANCHES);
    },
    async reviewNotes(path) {
      if (!findWorktree(path)) return reject("worktree_unknown", path);
      return structuredClone(notes.get(path) ?? []);
    },
    async reviewNotesPut(path, next) {
      if (!findWorktree(path)) return reject("worktree_unknown", path);
      const bad = firstBadNote(next);
      if (bad !== null) return reject("bad_note", bad);
      notes.set(path, structuredClone(next));
      return structuredClone(next);
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
      // Like Rust: pull when behind (a split history is refused), push when only ahead.
      const view = shipView(path);
      if (view instanceof Promise) return view;
      if (view.upstream === null) return reject("no_upstream");
      if (view.upstream.behind > 0) return doPull(path);
      if (view.upstream.ahead > 0) return doPush(path);
      return view;
    },
    async worktreeFetch(path) {
      return shipView(path);
    },
    async worktreeForcePush(path, expected, confirmed) {
      if (!confirmed) return reject("needs_approval", `force push ${path}`);
      const view = shipView(path);
      if (view instanceof Promise) return view;
      if (view.upstream === null) return reject("no_upstream");
      if (view.branch === view.base.replace(/^origin\//, "")) return reject("force_base", view.branch ?? "");
      // The lease: the remote must still be where the caller last saw it.
      if (expected !== view.upstream.id) return reject("push_rejected", "stale info");
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
      if (!prs.has(path)) return reject("gh_failed");
    },
    async worktreeCheckLog(path) {
      if (!findWorktree(path)) return reject("worktree_unknown", path);
      return null;
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
      const now = tree(path);
      const listing = now && demoListing(now.files, now.dirs, rel);
      return listing ? structuredClone(listing) : reject("not_found", dir);
    },
  };
}
