import type {
  Api,
  ApiError,
  FileText,
  RemoteConnState,
  RemoteDirListing,
  RemoteHostView,
  RemoteProject,
  RemoteProjectView,
  RemoteTarget,
  SshHost,
  WorktreeChange,
} from "./api";
import { mockHash } from "./mockFiles";

type RemoteApi = Pick<
  Api,
  | "remoteProjectsList"
  | "remoteProjectAdd"
  | "remoteProjectRemove"
  | "remoteBrowse"
  | "remoteConnect"
  | "remoteDisconnect"
  | "remoteHostsState"
  | "remoteTargetGet"
  | "remoteTargetSet"
  | "onRemoteState"
>;

/** The local calls an `ssh://` worktree takes over; any other worktree goes to the local mock. */
export type RemoteRouted = Pick<Api, "fileRead" | "fileWrite" | "fileCreate" | "fileRename" | "fileTrash" | "filesList" | "worktreeChanges">;

export type MockRemoteSsh = RemoteApi &
  RemoteRouted & {
    // The host drops: `reconnecting` (attempt 1) now, `connected` one tick later; both on `remote://state`.
    __remoteDrop(hostId: string): void;
    // The host goes offline until `remoteConnect`; file calls reject with `remote_offline`.
    __remoteOffline(hostId: string): void;
    // Every later call that needs the host rejects with `code` (e.g. `remote_denied`) until set to null.
    __remoteFail(hostId: string, code: ApiError["code"] | null): void;
  };

/** How long a mock connect or reconnect takes, in ms. */
export const MOCK_REMOTE_TICK = 300;

/** The host the mock always has, with a project folder at `/home/dev/app`. */
export const MOCK_REMOTE_HOST: SshHost = {
  id: "devbox",
  alias: "devbox",
  hostName: "devbox.internal",
  user: "dev",
  source: "manual",
  forwardAgent: false,
  localForwards: [],
  extraOptions: [],
};

export const MOCK_REMOTE_HOME = "/home/dev";

const SEED_FILES: Record<string, string> = {
  "/home/dev/app/src/main.ts": 'console.log("hello from devbox");\n',
  "/home/dev/app/README.md": "# app\n\nA project on devbox.\n",
  "/home/dev/app/.git/HEAD": "ref: refs/heads/main\n",
};

const fail = (code: ApiError["code"], detail?: string): never => {
  throw (detail === undefined ? { code } : { code, detail }) satisfies ApiError;
};

const parentOf = (path: string): string | null => {
  if (path === "/") return null;
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
};

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

/** `ssh://<host id><abs path>` as its parts, like `RemoteRef::parse`. */
export function parseRemote(worktree: string): { hostId: string; root: string } | null {
  const m = /^ssh:\/\/([A-Za-z0-9_-]+)(\/.*)$/.exec(worktree);
  if (!m || m[2].includes("\0")) return null;
  return { hostId: m[1], root: m[2] };
}

/** `root/rel` for a `rel` inside `root`, like `join_rel`; null for `..`, absolute, NUL, `\` or empty. */
export function joinRel(root: string, rel: string): string | null {
  if (rel.startsWith("/") || rel.includes("\0") || rel.includes("\\")) return null;
  const parts = rel.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.length === 0 || parts.includes("..")) return null;
  return `${root.replace(/\/+$/, "")}/${parts.join("/")}`;
}

// From the first line break, like the Rust reader.
const eolOf = (text: string) => {
  const at = text.indexOf("\n");
  return at > 0 && text[at - 1] === "\r" ? "crlf" : "lf";
};

/**
 * Remote projects over SSH, in memory: one host `devbox` (plus any saved SSH host from `hosts`), a folder
 * tree per host, and the file calls of an `ssh://` worktree routed to it; other worktrees go to `local`.
 */
export function createMockRemoteSsh(local: RemoteRouted, hosts: () => Promise<SshHost[]> = async () => []): MockRemoteSsh {
  // Per host: absolute path -> text for files, and the set of folders.
  const files = new Map<string, Map<string, string>>();
  const dirs = new Map<string, Set<string>>();
  const states = new Map<string, RemoteConnState>();
  let projects: RemoteProject[] = [];
  const targets = new Map<string, RemoteTarget>();
  const stateFns = new Set<(v: RemoteHostView) => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let next = 1;
  const failing = new Map<string, ApiError["code"]>();

  const treeOf = (hostId: string) => {
    let f = files.get(hostId);
    let d = dirs.get(hostId);
    if (!f || !d) {
      f = new Map(hostId === MOCK_REMOTE_HOST.id ? Object.entries(SEED_FILES) : []);
      d = new Set(["/", "/home", MOCK_REMOTE_HOME]);
      for (const path of f.keys()) for (let p = parentOf(path); p !== null; p = parentOf(p)) d.add(p);
      files.set(hostId, f);
      dirs.set(hostId, d);
    }
    return { f, d };
  };

  const allHosts = async (): Promise<SshHost[]> => {
    const saved = await hosts();
    return [MOCK_REMOTE_HOST, ...saved.filter((h) => h.id !== MOCK_REMOTE_HOST.id)];
  };
  const hostOf = async (hostId: string): Promise<SshHost> => (await allHosts()).find((h) => h.id === hostId) ?? fail("not_found", hostId);

  const stateOf = (hostId: string): RemoteConnState => states.get(hostId) ?? { state: "idle" };
  const hostView = (host: SshHost): RemoteHostView => ({ hostId: host.id, alias: host.alias, conn: structuredClone(stateOf(host.id)) });
  const setState = async (hostId: string, state: RemoteConnState) => {
    states.set(hostId, state);
    const host = (await allHosts()).find((h) => h.id === hostId);
    if (!host) return;
    const v = hostView(host);
    for (const fn of [...stateFns]) fn(structuredClone(v));
  };
  const connected: RemoteConnState = { state: "connected", tmux: true, git: true };
  const later = (hostId: string, fn: () => void) => {
    clearTimeout(timers.get(hostId));
    timers.set(hostId, setTimeout(fn, MOCK_REMOTE_TICK));
  };

  // A call that needs the host: offline and reconnecting reject; idle connects on the spot.
  const live = async (hostId: string) => {
    const s = stateOf(hostId).state;
    if (s === "offline" || s === "reconnecting") fail("remote_offline", hostId);
    const forced = failing.get(hostId);
    if (forced) fail(forced, hostId);
    if (s !== "connected") await setState(hostId, connected);
  };

  const projectView = async (p: RemoteProject): Promise<RemoteProjectView> => {
    const host = (await allHosts()).find((h) => h.id === p.hostId);
    return { ...p, hostAlias: host?.alias ?? p.hostId, worktree: `ssh://${p.hostId}${p.path}`, state: structuredClone(stateOf(p.hostId)) };
  };

  const resolve = (path: string) => {
    const abs = path === "~" || path === "" ? MOCK_REMOTE_HOME : path.startsWith("~/") ? `${MOCK_REMOTE_HOME}${path.slice(1)}` : path;
    if (!abs.startsWith("/")) return `${MOCK_REMOTE_HOME}/${abs}`.replace(/\/+$/, "");
    return abs === "/" ? "/" : abs.replace(/\/+$/, "");
  };

  // The host tree and the absolute path of `rel` in an `ssh://` worktree.
  const at = async (worktree: string, rel: string) => {
    const r = parseRemote(worktree) ?? fail("worktree_unknown", worktree);
    await hostOf(r.hostId).catch(() => fail("worktree_unknown", worktree));
    await live(r.hostId);
    const path = joinRel(r.root, rel) ?? fail("bad_path", rel);
    return { ...treeOf(r.hostId), path, root: r.root };
  };

  const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

  return {
    async remoteProjectsList() {
      return Promise.all(projects.map(projectView));
    },
    async remoteProjectAdd(hostId, path, name) {
      await hostOf(hostId);
      await live(hostId);
      const abs = resolve(path.trim());
      if (!treeOf(hostId).d.has(abs)) fail("remote_path", abs);
      const same = projects.find((p) => p.hostId === hostId && p.path === abs);
      if (same) return projectView(same);
      const project: RemoteProject = { id: `remote-${next++}`, hostId, path: abs, name: name?.trim() || baseName(abs), keepAlive: true, addedMs: Date.now() };
      projects = [...projects, project];
      return projectView(project);
    },
    async remoteProjectRemove(id) {
      if (!projects.some((p) => p.id === id)) fail("not_found", id);
      projects = projects.filter((p) => p.id !== id);
    },
    async remoteBrowse(hostId, path) {
      await hostOf(hostId);
      await live(hostId);
      const abs = resolve(path ?? MOCK_REMOTE_HOME);
      const { d } = treeOf(hostId);
      if (!d.has(abs)) fail("remote_path", abs);
      const prefix = abs === "/" ? "/" : `${abs}/`;
      const names = [...d].filter((p) => p !== abs && p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).map((p) => p.slice(prefix.length)).sort();
      const listing: RemoteDirListing = { path: abs, parent: parentOf(abs), dirs: names.map((n) => ({ name: n, path: `${prefix}${n}` })), truncated: false };
      return listing;
    },
    async remoteConnect(hostId) {
      const host = await hostOf(hostId);
      const s = stateOf(hostId).state;
      if (s === "connected" || s === "connecting") return hostView(host);
      await setState(hostId, { state: "connecting" });
      later(hostId, () => void setState(hostId, connected));
      return hostView(host);
    },
    async remoteDisconnect(hostId) {
      await hostOf(hostId);
      clearTimeout(timers.get(hostId));
      if (stateOf(hostId).state !== "idle") await setState(hostId, { state: "idle" });
    },
    async remoteHostsState() {
      return (await allHosts()).map(hostView);
    },
    async remoteTargetGet(repoId) {
      const t = targets.get(repoId);
      return t ? { ...t } : null;
    },
    async remoteTargetSet(repoId, target) {
      if (target === null) {
        targets.delete(repoId);
        return;
      }
      await hostOf(target.hostId);
      if (!target.path.startsWith("/")) fail("remote_path", target.path);
      targets.set(repoId, { hostId: target.hostId, path: target.path });
    },
    onRemoteState(cb) {
      stateFns.add(cb);
      return Promise.resolve(() => void stateFns.delete(cb));
    },
    __remoteDrop(hostId) {
      clearTimeout(timers.get(hostId));
      void setState(hostId, { state: "reconnecting", attempt: 1, nextInSecs: 1 });
      later(hostId, () => void setState(hostId, connected));
    },
    __remoteOffline(hostId) {
      clearTimeout(timers.get(hostId));
      void setState(hostId, { state: "offline", reason: "unreachable" });
    },
    __remoteFail(hostId, code) {
      if (code === null) failing.delete(hostId);
      else failing.set(hostId, code);
    },

    async fileRead(worktree, rel) {
      if (!parseRemote(worktree)) return local.fileRead(worktree, rel);
      const { f, d, path } = await at(worktree, rel);
      if (d.has(path)) fail("bad_path", rel);
      const text = f.get(path) ?? fail("remote_path", rel);
      const out: FileText = { rel, text, kind: "text", size: text.length, hash: mockHash(text), eol: eolOf(text) };
      return out;
    },
    async fileWrite(worktree, rel, text, eol, expected) {
      if (!parseRemote(worktree)) return local.fileWrite(worktree, rel, text, eol, expected);
      const { f, d, path } = await at(worktree, rel);
      if (d.has(path)) fail("bad_path", rel);
      if (!d.has(parentOf(path) ?? "/")) fail("remote_path", rel);
      const old = f.get(path);
      const disk = old === undefined ? null : mockHash(old);
      if (disk !== expected) return { type: "conflict", diskHash: disk ?? "" };
      const lf = text.replace(/\r\n?/g, "\n");
      const bytes = eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf;
      f.set(path, bytes);
      return { type: "saved", hash: mockHash(bytes) };
    },
    async fileCreate(worktree, rel, dir) {
      if (!parseRemote(worktree)) return local.fileCreate(worktree, rel, dir);
      const { f, d, path } = await at(worktree, rel);
      if (f.has(path) || d.has(path)) fail("exists", rel);
      if (!d.has(parentOf(path) ?? "/")) fail("remote_path", rel);
      if (dir) d.add(path);
      else f.set(path, "");
    },
    async fileRename(worktree, from, to) {
      if (!parseRemote(worktree)) return local.fileRename(worktree, from, to);
      const { f, d, path: src, root } = await at(worktree, from);
      const dst = joinRel(root, to) ?? fail("bad_path", to);
      if (src === dst) return;
      if (dst.startsWith(`${src}/`)) fail("bad_path", to);
      if (!f.has(src) && !d.has(src)) fail("remote_path", from);
      if (f.has(dst) || d.has(dst)) fail("exists", to);
      if (!d.has(parentOf(dst) ?? "/")) fail("remote_path", to);
      for (const [p, text] of [...f]) if (within(p, src)) {
        f.delete(p);
        f.set(dst + p.slice(src.length), text);
      }
      for (const p of [...d]) if (within(p, src)) {
        d.delete(p);
        d.add(dst + p.slice(src.length));
      }
    },
    // Remote delete is permanent (no trash on the host).
    async fileTrash(worktree, rel) {
      if (!parseRemote(worktree)) return local.fileTrash(worktree, rel);
      const { f, d, path } = await at(worktree, rel);
      if (!f.has(path) && !d.has(path)) fail("remote_path", rel);
      for (const p of [...f.keys()]) if (within(p, path)) f.delete(p);
      for (const p of [...d]) if (within(p, path)) d.delete(p);
    },
    async filesList(worktree) {
      const r = parseRemote(worktree);
      if (!r) return local.filesList(worktree);
      await hostOf(r.hostId).catch(() => fail("worktree_unknown", worktree));
      await live(r.hostId);
      const { f, d } = treeOf(r.hostId);
      if (!d.has(r.root)) fail("remote_path", r.root);
      const prefix = r.root === "/" ? "/" : `${r.root}/`;
      const list = [...f.keys()]
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length))
        .filter((p) => !p.startsWith(".git/") && !p.includes("/.git/"))
        .sort();
      return { files: list, truncated: false };
    },
    async worktreeChanges(path) {
      const r = parseRemote(path);
      if (!r) return local.worktreeChanges(path);
      await hostOf(r.hostId).catch(() => fail("worktree_unknown", path));
      await live(r.hostId);
      const changes: WorktreeChange[] = [{ path: "src/main.ts", kind: "modified" }];
      return changes;
    },
  };
}

/** The `worktree_*` and `file_reveal` calls the desktop refuses on an `ssh://` worktree with `remote_unsupported`, like `local_only`. */
export const REMOTE_UNSUPPORTED = {
  worktreeArchiveRun: "worktree_archive_run",
  worktreeAdopt: "worktree_adopt",
  worktreeRenameBranch: "worktree_rename_branch",
  worktreePin: "worktree_pin",
  worktreeRemove: "worktree_remove",
  worktreeArchive: "worktree_archive",
  worktreeDetails: "worktree_details",
  worktreeFileDiff: "worktree_file_diff",
  worktreeListDir: "worktree_list_dir",
  worktreeCommit: "worktree_commit",
  worktreeCreate: "worktree_create",
  worktreeNamePreview: "worktree_name_preview",
  worktreeRestore: "worktree_restore",
  worktreeFileHead: "worktree_file_head",
  worktreeFileHeadBytes: "worktree_file_head_bytes",
  worktreeShip: "worktree_ship",
  worktreePush: "worktree_push",
  worktreePull: "worktree_pull",
  worktreeFastForward: "worktree_fast_forward",
  worktreeRebaseFromBase: "worktree_rebase_from_base",
  worktreeLog: "worktree_log",
  worktreeCommitFiles: "worktree_commit_files",
  worktreeCommitFile: "worktree_commit_file",
  worktreeOpenCommit: "worktree_open_commit",
  worktreeOpenFileOnHost: "worktree_open_file_on_host",
  worktreeSync: "worktree_sync",
  worktreeFetch: "worktree_fetch",
  worktreeForcePush: "worktree_force_push",
  worktreeSyncFork: "worktree_sync_fork",
  worktreeAmend: "worktree_amend",
  worktreePr: "worktree_pr",
  worktreePrCreate: "worktree_pr_create",
  worktreePrChecks: "worktree_pr_checks",
  worktreePrComments: "worktree_pr_comments",
  worktreePrCommentPost: "worktree_pr_comment_post",
  worktreePrHead: "worktree_pr_head",
  worktreePrThreadResolve: "worktree_pr_thread_resolve",
  worktreePrReaction: "worktree_pr_reaction",
  worktreePrChecksRerun: "worktree_pr_checks_rerun",
  worktreePrMergeInfo: "worktree_pr_merge_info",
  worktreePrMerge: "worktree_pr_merge",
  worktreePrOpen: "worktree_pr_open",
  worktreeCheckLog: "worktree_check_log",
  worktreeDraftCommit: "worktree_draft_commit",
  worktreeDraftPr: "worktree_draft_pr",
  worktreeReview: "worktree_review",
  worktreeReviewFile: "worktree_review_file",
  worktreeStage: "worktree_stage",
  worktreeBranches: "worktree_branches",
  worktreeCheckoutBranch: "worktree_checkout_branch",
  worktreeStageState: "worktree_stage_state",
  worktreeDiscard: "worktree_discard",
  worktreeSuggestBranch: "worktree_suggest_branch",
  worktreeConflicts: "worktree_conflicts",
  worktreeConflictContinue: "worktree_conflict_continue",
  worktreeConflictAbort: "worktree_conflict_abort",
  worktreeConflictResolve: "worktree_conflict_resolve",
  fileReveal: "file_reveal",
} as const;

export type RemoteGuarded = Pick<Api, keyof typeof REMOTE_UNSUPPORTED | "worktreeStat">;

/** `local`'s calls with the desktop's guards: an `ssh://` path or repo id is refused, `worktreeStat` counts `git status`. */
export function guardRemote(local: RemoteGuarded, remote: Pick<Api, "worktreeChanges">): RemoteGuarded {
  const out: Record<string, (first: string, ...rest: unknown[]) => Promise<unknown>> = {};
  for (const [name, command] of Object.entries(REMOTE_UNSUPPORTED)) {
    const fn = local[name as keyof typeof REMOTE_UNSUPPORTED] as (first: string, ...rest: unknown[]) => Promise<unknown>;
    out[name] = async (first, ...rest) => (first.startsWith("ssh://") ? fail("remote_unsupported", command) : fn.call(local, first, ...rest));
  }
  const guarded = out as unknown as RemoteGuarded;
  // Taken now: `local` may be the object these calls replace.
  const stat = local.worktreeStat.bind(local);
  return {
    ...guarded,
    async worktreeStat(path) {
      if (!parseRemote(path)) return stat(path);
      return { files: (await remote.worktreeChanges(path)).length, added: 0, removed: 0 };
    },
  };
}
