import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Accounts,
  Account,
  Change,
  CmdError,
  Commit,
  DocEntry,
  DocLink,
  Expected,
  ExportPlan,
  FileDiff,
  Freshness,
  LoginStart,
  Models,
  Provider,
  PtyExit,
  PtyInfo,
  Quota,
  RouteRule,
  Routing,
  SearchHit,
  Seat,
  Seen,
  Event as SquadEvent,
  Squad,
  SquadItem,
  SquadView,
  StaleDoc,
  Task,
  TasksContext,
  UpdateInfo,
  VaultChanged,
  VaultSetup,
  VcsState,
  RepoView,
  WorktreeChange,
  WorktreeFileDiff,
  WorktreeView,
} from "@xdev/bindings";
import type { DirEntry, DirListing } from "@xdev/bindings";
import type { Target } from "./doc/frontmatter";
import { toBytes } from "./terminal/ptyClient";
import { createMockApi, DEMO_AI_EDIT, DEMO_COMMITS, DEMO_OUTSIDE_EDIT, DEMO_ROOT, DEMO_SEED } from "./mockApi";

export { createMockApi };
export type { Target };
export type { DirEntry, DirListing };

// The IPC types come from Rust; see packages/bindings/README.md.
export type {
  Account,
  Accounts,
  Change,
  ChangeKind,
  Commit,
  DocEntry,
  DocLink,
  DocState,
  Expected,
  ExportPlan,
  FileDiff,
  Freshness,
  LoginStart,
  Models,
  Provider,
  PtyExit,
  PtyInfo,
  Quota,
  RouteRule,
  Routing,
  ContextUse,
  Escalation,
  Role,
  SearchHit,
  Seat,
  SeatState,
  SeatStatus,
  Seen,
  Squad,
  SquadItem,
  SquadRun,
  SquadStatus,
  SquadView,
  StaleDoc,
  Step,
  Task,
  TasksContext,
  TaskState,
  UpdateInfo,
  VaultSetup,
  VcsState,
  RepoView,
  WorktreeChange,
  WorktreeFileDiff,
  WorktreeSkip,
  WorktreeView,
} from "@xdev/bindings";
// The UI's names for generated types.
export type { Event as SquadEvent, FileStatus as ExportStatus, PlannedFile as ExportFile } from "@xdev/bindings";

// Types do not exist at run time, so the provider menu needs its own list.
export const PROVIDERS: readonly Provider[] = ["claude", "codex"];

// What a terminal tab can start; Rust maps each id to a program (`xdev_agent::launch`).
export type PtyProfile = "shell" | "claude" | "codex";
export const PTY_PROFILES: readonly PtyProfile[] = ["shell", "claude", "codex"];

// Rust builds `CmdError.code` from each crate's `code()` as a plain string, so the codes the UI
// knows how to translate are listed here by hand.
export type ErrorCode =
  | "not_found"
  | "outside_vault"
  | "no_vault"
  | "io"
  | "not_utf8"
  | "too_large"
  | "no_git"
  | "no_repo"
  | "git"
  | "git_identity"
  | "stale"
  | "conflict"
  | "changed"
  | "bad_name"
  | "exists"
  | "no_claude"
  | "no_codex"
  | "unknown_provider"
  | "bad_registry"
  | "bad_reserve"
  | "bad_path"
  | "no_commits"
  | "empty_goal"
  | "needs_approval"
  | "denied"
  | "dirty_repo"
  | "merge_conflict"
  | "bad_state"
  | "detached"
  | "no_session"
  | "no_worktree"
  | "runner"
  | "timeout"
  | "policy_invalid"
  | "binary"
  | "stopped"
  | "seat_vacant"
  | "unknown_account"
  | "busy"
  | "bad_role"
  | "empty_name"
  | "no_run"
  | "not_waiting"
  | "empty_text"
  | "update"
  | "pty_exists"
  | "pty_unknown"
  | "pty_spawn"
  | "pty_resize"
  | "bad_arg"
  | "unknown_profile"
  | "registry_corrupt"
  | "repo_exists"
  | "repo_unknown"
  | "worktree_unknown"
  | "worktree_exists"
  | "branch_exists"
  | "bad_ref"
  | "worktree_dirty"
  | "primary_worktree"
  | "empty_message";
export type ApiError = Omit<CmdError, "code"> & { code: ErrorCode };

export interface Api {
  // The downloaded update waiting for a restart, if any; Rust checks and downloads on its own.
  updateStatus(): Promise<UpdateInfo | null>;
  onUpdateReady(cb: (update: UpdateInfo) => void): Promise<() => void>;
  // Restarts the app once installed, so it resolves only when there was nothing to install.
  restartToUpdate(): Promise<void>;
  // An OS notification; the text comes from here so it follows the UI language.
  notifyUpdate(title: string, body: string): Promise<void>;
  accounts(): Promise<Accounts>;
  quota(): Promise<Quota[]>;
  // With `dir`, an existing config folder is registered as is (a hive
  // account, say); without it a new folder is made for a login.
  addAccount(name: string, provider: Provider, dir?: string): Promise<Account>;
  loginAccount(name: string): Promise<LoginStart>;
  removeAccount(name: string): Promise<void>;
  // The first rule that matches a turn picks its model.
  routing(): Promise<Routing>;
  setRouting(routing: Routing): Promise<void>;
  /** What each CLI offers; a missing CLI gives an empty list. */
  models(): Promise<Models>;
  tasksContext(): Promise<TasksContext>;
  // Newest first.
  tasks(): Promise<Task[]>;
  task(id: string): Promise<Task>;
  newTask(repo: string, goal: string): Promise<Task>;
  // Resolves when the agent and the test are done, which can take up to an hour; meanwhile
  // `tasks()` reports the task as `running`. Rejects with `needs_approval` / `denied` when the
  // policy stops it, the reason in `detail`. `test` is split on whitespace.
  runTask(id: string, account: string | null, test: string | null): Promise<Task>;
  resumeTask(id: string, account: string | null): Promise<Task>;
  approveTask(id: string): Promise<Task>;
  discardTask(id: string): Promise<Task>;
  // Rejects with `binary` for a file that is not text.
  taskFileDiff(id: string, path: string): Promise<FileDiff>;
  // Newest first.
  squads(): Promise<SquadItem[]>;
  squad(id: string): Promise<SquadView>;
  // A seat with a null or blank account is vacant; `test` is split on whitespace.
  newSquad(name: string, repo: string, seats: Seat[], test: string | null): Promise<Squad>;
  // Rejects with `busy` while a run is going.
  setSeat(id: string, role: string, account: string | null): Promise<SquadView>;
  removeSquad(id: string): Promise<void>;
  // These resolve when the run is done, waits for the person or is stopped, which can take an
  // hour; meanwhile `squad()` shows it running. Steer resolves at once while a seat is working.
  runSquad(id: string, goal: string): Promise<SquadView>;
  answerSquad(id: string, escalation: string, text: string): Promise<SquadView>;
  steerSquad(id: string, role: string, text: string): Promise<SquadView>;
  resumeSquad(id: string): Promise<SquadView>;
  // Works while another call is running the squad; that call then resolves as stopped.
  stopSquad(id: string): Promise<SquadView>;
  // Oldest first.
  squadEvents(id: string): Promise<SquadEvent[]>;
  pickFolder(): Promise<string | null>;
  openVault(path: string): Promise<DocEntry[]>;
  lastVault(): Promise<string | null>;
  // `prompt` is true until the first-run offer has been answered or any folder opened.
  vaultSetup(): Promise<VaultSetup>;
  dismissVaultPrompt(): Promise<void>;
  // Writes `file` only into a new or empty folder; does not open it.
  createVault(path: string, file: string, content: string): Promise<void>;
  listDocs(): Promise<DocEntry[]>;
  readDoc(path: string): Promise<string>;
  writeDoc(path: string, content: string): Promise<void>;
  // Rejects with `exists` instead of replacing a file; the parent folder must exist.
  createDoc(path: string, content: string): Promise<void>;
  // The CLI shipped beside the app, so setup commands work without it on PATH; null when absent.
  cliPath(): Promise<string | null>;
  search(query: string, limit: number): Promise<SearchHit[]>;
  onVaultChanged(cb: (paths: string[]) => void): Promise<() => void>;
  vcsState(): Promise<VcsState>;
  initRepo(): Promise<void>;
  listChanges(): Promise<Change[]>;
  readBase(path: string): Promise<string | null>;
  approve(changes: Seen[], message: string): Promise<string | null>;
  reject(changes: Seen[]): Promise<void>;
  history(path: string, limit: number): Promise<Commit[]>;
  readVersion(path: string, id: string): Promise<string | null>;
  restoreVersion(path: string, id: string): Promise<void>;
  backlinks(path: string): Promise<DocLink[]>;
  exportPlan(): Promise<ExportPlan>;
  // Rejects with `stale` when the files to write no longer match `expected`.
  exportWrite(expected: Expected[]): Promise<string[]>;
  // Reads the saved file, so it follows saves rather than the draft.
  docFreshness(path: string): Promise<Freshness>;
  staleDocs(): Promise<StaleDoc[]>;
  // A terminal per tab. Output arrives on `onData` until the tab calls `ptyKill`; an agent profile
  // rejects with `needs_approval` / `denied` until `ptyApprove` records it in the policy.
  ptySpawn(id: string, cwd: string, profileId: PtyProfile, cols: number, rows: number, onData: (bytes: Uint8Array) => void): Promise<PtyInfo>;
  ptyApprove(profileId: PtyProfile): Promise<void>;
  ptyWrite(id: string, data: Uint8Array): Promise<void>;
  ptyResize(id: string, cols: number, rows: number): Promise<void>;
  // Output is paused once 4 MB are unacknowledged.
  ptyAck(id: string, n: number): Promise<void>;
  // An unknown id has already ended, so this never rejects.
  ptyKill(id: string): Promise<void>;
  onPtyExit(cb: (exit: PtyExit) => void): Promise<() => void>;
  // Every repo the workspace knows, each with its primary checkout first; a repo whose folder is
  // gone stays in the list as `missing`.
  workspaceList(): Promise<RepoView[]>;
  // Rejects with `repo_exists` for a repo that is already listed.
  repoAdd(path: string): Promise<RepoView>;
  // Only the entry goes; nothing on disk is touched.
  repoForget(id: string): Promise<void>;
  // A new branch and folder; a blank `name` gets a free word, a null `from` starts at the repo's
  // base ref. Rejects with `bad_name`, `branch_exists`, `worktree_exists` or `bad_ref`.
  worktreeCreate(repoId: string, name: string, from: string | null): Promise<WorktreeView>;
  worktreePin(path: string, pinned: boolean): Promise<void>;
  // Rejects with `needs_approval` until `confirmed`, then with `worktree_dirty` for uncommitted
  // work until `force`, and with `primary_worktree` for the main checkout.
  worktreeRemove(path: string, force: boolean, confirmed: boolean): Promise<void>;
  // Against the commit the worktree started from.
  worktreeChanges(path: string): Promise<WorktreeChange[]>;
  worktreeFileDiff(path: string, file: string): Promise<WorktreeFileDiff>;
  // The new commit's id, or null when none of `files` had a change. Rejects with `empty_message`.
  worktreeCommit(path: string, files: string[], message: string): Promise<string | null>;
  // One folder level of a worktree (`dir` is relative; "" is the top): folders first, then files,
  // A to Z, `.git` left out, links listed as files and never followed, at most 2000 names with
  // `truncated` set past that. Rejects with `bad_path` for `..`, an absolute path or a link.
  worktreeListDir(path: string, dir: string): Promise<DirListing>;
}

function seen({ path, hash }: Seen): Seen {
  return { path, hash };
}

export const ERROR_CODES: readonly ErrorCode[] = [
  "not_found",
  "outside_vault",
  "no_vault",
  "io",
  "not_utf8",
  "too_large",
  "no_git",
  "no_repo",
  "git",
  "git_identity",
  "stale",
  "conflict",
  "changed",
  "bad_name",
  "exists",
  "no_claude",
  "no_codex",
  "unknown_provider",
  "bad_registry",
  "bad_reserve",
  "bad_path",
  "no_commits",
  "empty_goal",
  "needs_approval",
  "denied",
  "dirty_repo",
  "merge_conflict",
  "bad_state",
  "detached",
  "no_session",
  "no_worktree",
  "runner",
  "timeout",
  "policy_invalid",
  "binary",
  "stopped",
  "seat_vacant",
  "unknown_account",
  "busy",
  "bad_role",
  "empty_name",
  "no_run",
  "not_waiting",
  "empty_text",
  "update",
  "pty_exists",
  "pty_unknown",
  "pty_spawn",
  "pty_resize",
  "bad_arg",
  "unknown_profile",
  "registry_corrupt",
  "repo_exists",
  "repo_unknown",
  "worktree_unknown",
  "worktree_exists",
  "branch_exists",
  "bad_ref",
  "worktree_dirty",
  "primary_worktree",
  "empty_message",
];

// Tauri can also reject with a plain string (e.g. an unknown command), which the UI must still translate.
export function toApiError(e: unknown): ApiError {
  if (typeof e === "object" && e !== null && ERROR_CODES.includes((e as ApiError).code)) return e as ApiError;
  return { code: "io", detail: String(e) };
}

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args).catch((e: unknown) => Promise.reject(toApiError(e)));
}

const tauriApi: Api = {
  updateStatus: () => call("update_status"),
  onUpdateReady: (cb) => listen<UpdateInfo>("update-ready", (e) => cb(e.payload)),
  restartToUpdate: () => call("update_restart"),
  notifyUpdate: (title, body) => call("update_notify", { title, body }),
  accounts: () => call("accounts_list"),
  quota: () => call("accounts_quota"),
  addAccount: (name, provider, dir) => call("account_add", { name, provider, dir: dir ?? null }),
  loginAccount: (name) => call("account_login", { name }),
  removeAccount: (name) => call("account_remove", { name }),
  routing: () => call("routing_get"),
  setRouting: (routing) => call("routing_set", { routing }),
  models: () => call("routing_models"),
  tasksContext: () => call("tasks_context"),
  tasks: () => call("tasks_list"),
  task: (id) => call("task_get", { id }),
  newTask: (repo, goal) => call("task_new", { repo, goal }),
  runTask: (id, account, test) => call("task_run", { id, account, test }),
  resumeTask: (id, account) => call("task_resume", { id, account }),
  approveTask: (id) => call("task_approve", { id }),
  discardTask: (id) => call("task_discard", { id }),
  taskFileDiff: (id, path) => call("task_file_diff", { id, path }),
  squads: () => call("squads_list"),
  squad: (id) => call("squad_get", { id }),
  newSquad: (name, repo, seats, test) => call("squad_new", { name, repo, seats, test }),
  setSeat: (id, role, account) => call("squad_set_seat", { id, role, account }),
  removeSquad: (id) => call("squad_remove", { id }),
  runSquad: (id, goal) => call("squad_run", { id, goal }),
  answerSquad: (id, escalation, text) => call("squad_answer", { id, escalation, text }),
  steerSquad: (id, role, text) => call("squad_steer", { id, role, text }),
  resumeSquad: (id) => call("squad_resume", { id }),
  stopSquad: (id) => call("squad_stop", { id }),
  squadEvents: (id) => call("squad_events", { id }),
  async pickFolder() {
    const picked = await open({ directory: true });
    return typeof picked === "string" ? picked : null;
  },
  openVault: (path) => call("open_vault", { path }),
  lastVault: () => call("last_vault"),
  vaultSetup: () => call("vault_setup"),
  dismissVaultPrompt: () => call("dismiss_vault_prompt"),
  createVault: (path, file, content) => call("create_vault", { path, file, content }),
  listDocs: () => call("list_docs"),
  readDoc: (path) => call("read_doc", { path }),
  writeDoc: (path, content) => call("write_doc", { path, content }),
  createDoc: (path, content) => call("create_doc", { path, content }),
  cliPath: () => call("cli_path"),
  search: (query, limit) => call("search", { query, limit }),
  onVaultChanged: (cb) => listen<VaultChanged>("vault://changed", (e) => cb(e.payload.paths)),
  vcsState: () => call("vcs_state"),
  initRepo: () => call("init_repo"),
  listChanges: () => call("list_changes"),
  readBase: (path) => call("read_base", { path }),
  approve: (changes, message) => call("approve", { changes: changes.map(seen), message }),
  reject: (changes) => call("reject", { changes: changes.map(seen) }),
  history: (path, limit) => call("history", { path, limit }),
  readVersion: (path, id) => call("read_version", { path, id }),
  restoreVersion: (path, id) => call("restore_version", { path, id }),
  backlinks: (path) => call("backlinks", { path }),
  exportPlan: () => call("export_plan"),
  exportWrite: (expected) => call("export_write", { expected }),
  docFreshness: (path) => call("doc_freshness", { path }),
  staleDocs: () => call("stale_docs"),
  ptySpawn(id, cwd, profileId, cols, rows, onData) {
    // Rust sends raw bytes, which arrive as an ArrayBuffer.
    const out = new Channel<ArrayBuffer | number[]>();
    out.onmessage = (msg) => onData(toBytes(msg));
    return call("pty_spawn", { id, cwd, profileId, cols, rows, out });
  },
  ptyApprove: (profileId) => call("pty_approve", { profileId }),
  ptyWrite: (id, data) => call("pty_write", { id, data: [...data] }),
  ptyResize: (id, cols, rows) => call("pty_resize", { id, cols, rows }),
  ptyAck: (id, n) => call("pty_ack", { id, n }),
  ptyKill: (id) => call("pty_kill", { id }),
  onPtyExit: (cb) => listen<PtyExit>("pty://exit", (e) => cb(e.payload)),
  workspaceList: () => call("workspace_list"),
  repoAdd: (path) => call("repo_add", { path }),
  repoForget: (id) => call("repo_forget", { id }),
  worktreeCreate: (repoId, name, from) => call("worktree_create", { repoId, name, from }),
  worktreePin: (path, pinned) => call("worktree_pin", { path, pinned }),
  worktreeRemove: (path, force, confirmed) => call("worktree_remove", { path, force, confirmed }),
  worktreeChanges: (path) => call("worktree_changes", { path }),
  worktreeFileDiff: (path, file) => call("worktree_file_diff", { path, file }),
  worktreeCommit: (path, files, message) => call("worktree_commit", { path, files, message }),
  worktreeListDir: (path, dir) => call("worktree_list_dir", { path, dir }),
};

function browserApi(): Api {
  const params = new URLSearchParams(location.search);
  const mock = createMockApi(DEMO_SEED, { repo: !params.has("norepo"), commits: DEMO_COMMITS, runDelayMs: 4000 });
  // Lets the preview simulate an AI agent or another editor from the devtools console.
  Object.assign(window, { xdevMock: mock });
  // The preview lands in the demo vault so the main layout is reachable without a dialog;
  // `?welcome` simulates a first launch instead.
  const firstRun = params.has("welcome");
  let seeded = false;
  return {
    ...mock,
    lastVault: async () => (await mock.lastVault()) ?? (firstRun ? null : DEMO_ROOT),
    async openVault(path) {
      const docs = await mock.openVault(path);
      // One pending outside edit and one agent proposal, so the Changes tab has something to review.
      if (!seeded && (await mock.vcsState()).status === "ok") {
        mock.__editOutside("README.md", DEMO_OUTSIDE_EDIT);
        mock.__propose(DEMO_AI_EDIT.path, DEMO_AI_EDIT.content, DEMO_AI_EDIT.note);
      }
      seeded = true;
      return docs;
    },
  };
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const api: Api = isTauri() ? tauriApi : typeof window !== "undefined" ? browserApi() : createMockApi(DEMO_SEED);
