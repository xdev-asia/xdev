import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Accounts,
  Approvals,
  Account,
  Change,
  CmdError,
  Commit,
  CustomShell,
  DocEntry,
  DocLink,
  Expected,
  ExportPlan,
  FileDiff,
  Freshness,
  LoginStart,
  Models,
  Profile,
  ProfilesView,
  Provider,
  PtyExit,
  PtyHook,
  PtyInfo,
  StatusSettings,
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
  VaultView,
  VcsState,
  RepoView,
  WorktreeChange,
  WorktreeFileDiff,
  ReviewBranch,
  ReviewData,
  ReviewNote,
  WorktreeStat,
  WorktreeView,
  Check,
  PrDraft,
  PrView,
  ShipView,
} from "@xdev/bindings";
import type {
  DirEntry,
  DirListing,
  Home,
  KitText,
  MemorySet,
  PromptEntry,
  Skill,
  UsageSummary,
} from "@xdev/bindings";
import type { Target } from "./doc/frontmatter";
import { toBytes } from "./terminal/ptyClient";
import { createMockApi, DEMO_AI_EDIT, DEMO_COMMITS, DEMO_OUTSIDE_EDIT, DEMO_ROOT, DEMO_SEED } from "./mockApi";

export { createMockApi };
export type { Target };
export type { DirEntry, DirListing, Home, KitText, MemorySet, PromptEntry, Skill, UsageSummary };

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
  Approvals,
  CustomShell,
  Permissions,
  Profile,
  ProfileView,
  ProfilesView,
  ShellView,
  Provider,
  PtyExit,
  PtyHook,
  PtyInfo,
  StatusSettings,
  HookEvent,
  HookDetail,
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
  VaultKind,
  VaultSetup,
  VaultView,
  VcsState,
  RepoView,
  WorktreeChange,
  WorktreeFileDiff,
  ReviewBase,
  ReviewBranch,
  ReviewData,
  ReviewFile,
  ReviewNote,
  WorktreeSkip,
  WorktreeStat,
  WorktreeView,
  Check,
  PrDraft,
  PrView,
  ShipView,
} from "@xdev/bindings";
// The UI's names for generated types.
export type { Event as SquadEvent, FileStatus as ExportStatus, PlannedFile as ExportFile } from "@xdev/bindings";

// Types do not exist at run time, so the provider menu needs its own list.
export const PROVIDERS: readonly Provider[] = ["claude", "codex"];

// What a terminal tab can start; Rust maps each id to a program (`xdev_agent::launch`).
// A profile id: `shell`, a built-in (`claude`, `codex`, `gemini`), a custom id, or a `shell:` menu id.
export type PtyProfile = string;

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
  | "bad_note"
  | "worktree_dirty"
  | "primary_worktree"
  | "empty_message"
  | "bad_profiles"
  | "invalid_profile"
  | "builtin_profile"
  | "profile_off"
  | "not_installed"
  | "outside"
  | "kit_bad_input"
  | "short_name_taken"
  | "vault_exists"
  | "vault_unknown"
  | "no_remote"
  | "no_upstream"
  | "push_rejected"
  | "pull_diverged"
  | "force_base"
  | "nothing_to_amend"
  | "amend_pushed"
  | "hook_failed"
  | "not_pushed"
  | "empty_title"
  | "gh_missing"
  | "gh_auth"
  | "not_github"
  | "gh_failed"
  | "draft_failed"
  | "bad_sound";
export type ApiError = Omit<CmdError, "code"> & { code: ErrorCode };

export type RepoPatch = { shortName?: string; baseRef?: string; worktreeRoot?: string };

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
  ptySpawn(id: string, cwd: string, profileId: PtyProfile, account: string | null, cols: number, rows: number, onData: (bytes: Uint8Array) => void): Promise<PtyInfo>;
  ptyApprove(profileId: PtyProfile, account: string | null): Promise<void>;
  // Agent profiles and the shells of the `+` menu; each write returns the whole view.
  profiles(): Promise<ProfilesView>;
  profilePut(p: Profile): Promise<ProfilesView>;
  profileRemove(id: string): Promise<ProfilesView>;
  profileReset(id: string): Promise<ProfilesView>;
  profilesDefaults(approvals: Approvals, defaultAgent: string, defaultShell: string | null): Promise<ProfilesView>;
  shellPut(s: CustomShell): Promise<ProfilesView>;
  shellRemove(id: string): Promise<ProfilesView>;
  ptyWrite(id: string, data: Uint8Array): Promise<void>;
  ptyResize(id: string, cols: number, rows: number): Promise<void>;
  // Output is paused once 4 MB are unacknowledged.
  ptyAck(id: string, n: number): Promise<void>;
  // An unknown id has already ended, so this never rejects.
  ptyKill(id: string): Promise<void>;
  onPtyExit(cb: (exit: PtyExit) => void): Promise<() => void>;
  // A status line an agent's hook wrote for one terminal (`pty://hook`).
  onPtyHook(cb: (hook: PtyHook) => void): Promise<() => void>;
  // Status channels; `statusSettingsPut` clamps the volume to 0..100 and returns what was stored.
  statusSettings(): Promise<StatusSettings>;
  statusSettingsPut(settings: StatusSettings): Promise<StatusSettings>;
  // An OS notification for one terminal; best effort, never rejects.
  statusNotify(title: string, body: string, ptyId: string): Promise<void>;
  // A click on a status notification, when the OS reports one.
  onStatusNotificationClick(cb: (ptyId: string) => void): Promise<() => void>;
  // The taskbar / dock badge; 0 clears it. Never rejects.
  statusBadge(count: number): Promise<void>;
  // Copies the person's own sound (wav, mp3 or ogg, at most 1 MiB) or clears it with null;
  // rejects with `bad_sound`.
  statusSoundSet(path: string | null): Promise<StatusSettings>;
  // The own sound's bytes, or null when none is set or the file is gone.
  statusSound(): Promise<Uint8Array | null>;
  // Picks a sound file to pass to `statusSoundSet`; null when cancelled.
  pickSoundFile(): Promise<string | null>;
  // Every repo the workspace knows, each with its primary checkout first; a repo whose folder is
  // gone stays in the list as `missing`.
  workspaceList(): Promise<RepoView[]>;
  // Rejects with `repo_exists` for a repo that is already listed.
  repoAdd(path: string): Promise<RepoView>;
  // Only the entry goes; nothing on disk is touched.
  repoForget(id: string): Promise<void>;
  // Only the fields given change. Rejects with `bad_name` / `short_name_taken` for the short name,
  // `bad_ref` for a base ref that does not resolve, `bad_path` for a worktree folder that is relative
  // or inside the primary checkout; a refused patch saves nothing.
  repoUpdate(id: string, patch: RepoPatch): Promise<RepoView>;
  // Records a worktree from `RepoView.found`. Rejects with `worktree_exists` when it is already
  // recorded and `worktree_unknown` when no repo has it.
  worktreeAdopt(path: string): Promise<WorktreeView>;
  // Repo vaults (each repo's `docs/`, `exists: false` when there is none) then shared vaults.
  vaultList(): Promise<VaultView[]>;
  // Rejects with `bad_path` for a folder that is not there, `vault_exists` for one already listed.
  vaultAdd(path: string): Promise<VaultView>;
  // Only the record goes; the folder stays. Rejects with `vault_unknown`.
  vaultForget(id: string): Promise<void>;
  // Makes the repo's `docs/` with a starter doc; a folder with anything in it is left alone.
  vaultCreateDocs(repoId: string, file: string, content: string): Promise<VaultView>;
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
  // Line counts against the start ref (against HEAD for the primary checkout), untracked files included.
  worktreeStat(path: string): Promise<WorktreeStat>;
  // Shipping: where the branch stands against its upstream and base. Push, pull, sync and fetch
  // resolve with the new state. Push rejects with `no_remote`, `detached` or `push_rejected`; pull
  // with `no_upstream` or `pull_diverged`; a commit or amend with `hook_failed` (detail is the hook output).
  worktreeShip(path: string): Promise<ShipView>;
  worktreePush(path: string): Promise<ShipView>;
  worktreePull(path: string): Promise<ShipView>;
  worktreeSync(path: string): Promise<ShipView>;
  worktreeFetch(path: string): Promise<ShipView>;
  // `expected` is the remote commit the caller saw; without `confirmed` this rejects with `needs_approval`.
  worktreeForcePush(path: string, expected: string, confirmed: boolean): Promise<ShipView>;
  // The new commit's id. Rejects with `nothing_to_amend`, or `amend_pushed` unless `confirmed`.
  worktreeAmend(path: string, files: string[], message: string, confirmed: boolean): Promise<string>;
  // Pull requests through the `gh` tool; null when the branch has none.
  worktreePr(path: string): Promise<PrView | null>;
  worktreePrCreate(path: string, draft: PrDraft): Promise<PrView>;
  worktreePrChecks(path: string, number: number): Promise<Check[]>;
  worktreePrOpen(path: string, checks: boolean): Promise<void>;
  // Drafted texts; reject with `draft_failed`.
  worktreeDraftCommit(path: string, files: string[]): Promise<string>;
  worktreeDraftPr(path: string): Promise<PrDraft>;
  // One folder level of a worktree (`dir` is relative; "" is the top): folders first, then files,
  // A to Z, `.git` left out, links listed as files and never followed, at most 2000 names with
  // `truncated` set past that. Rejects with `bad_path` for `..`, an absolute path or a link.
  worktreeListDir(path: string, dir: string): Promise<DirListing>;
  // Review: every change against a base. `base` null is the start (HEAD for the primary checkout); a
  // branch, ref or commit id is compared from its merge base with HEAD. Rejects with `bad_ref`.
  worktreeReview(path: string, base: string | null): Promise<ReviewData>;
  // One file's two sides at `base`, which must be the commit id `worktreeReview` returned.
  worktreeReviewFile(path: string, base: string, file: string): Promise<WorktreeFileDiff>;
  // Whole files: stage them, or put the index back to HEAD.
  worktreeStage(path: string, files: string[], staged: boolean): Promise<void>;
  worktreeBranches(path: string): Promise<ReviewBranch[]>;
  // Review notes of one worktree. A put replaces them all and rejects with `bad_note` when any is invalid.
  reviewNotes(path: string): Promise<ReviewNote[]>;
  reviewNotesPut(path: string, notes: ReviewNote[]): Promise<ReviewNote[]>;
  // Agent kit. Every path is checked in Rust against the agent homes, the app data folder and
  // `worktree` (a repo or worktree the workspace knows; any other rejects with `outside`).
  kitHomes(): Promise<Home[]>;
  kitSkills(worktree: string | null): Promise<Skill[]>;
  kitMemory(worktree: string | null): Promise<MemorySet>;
  kitRead(path: string, worktree: string | null): Promise<KitText>;
  // `stamp` is the one `kitRead` gave (null for a new file); a file changed since rejects with
  // `changed`. Resolves with the new stamp.
  kitWrite(path: string, text: string, stamp: string | null, worktree: string | null): Promise<string>;
  kitCopy(from: string, to: string, worktree: string | null): Promise<void>;
  // Resolves with the new skill folder.
  kitSkillCopy(dir: string, toSkillsDir: string, worktree: string | null): Promise<string>;
  // Resolves with the path of the new SKILL.md.
  kitSkillNew(skillsDir: string, name: string, description: string, worktree: string | null): Promise<string>;
  // Moves the folder aside and resolves with where it went, for `kitSkillRestore`.
  kitSkillRemove(dir: string, worktree: string | null): Promise<string>;
  kitSkillRestore(removed: string, to: string, worktree: string | null): Promise<void>;
  // Days are local `YYYY-MM-DD`; `refresh` reads the new session log bytes first.
  kitUsage(sinceDay: string, untilDay: string, refresh: boolean): Promise<UsageSummary>;
  // Whether each relative path exists under `root` (an agent home, repo or worktree).
  kitPathsExist(root: string, paths: string[]): Promise<boolean[]>;
  // Newest first, at most `limit` (and 1000).
  kitPromptHistory(limit: number): Promise<PromptEntry[]>;
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
  "bad_note",
  "worktree_dirty",
  "primary_worktree",
  "empty_message",
  "bad_profiles",
  "invalid_profile",
  "builtin_profile",
  "profile_off",
  "not_installed",
  "outside",
  "kit_bad_input",
  "short_name_taken",
  "vault_exists",
  "vault_unknown",
  "no_remote",
  "no_upstream",
  "push_rejected",
  "pull_diverged",
  "force_base",
  "nothing_to_amend",
  "amend_pushed",
  "hook_failed",
  "not_pushed",
  "empty_title",
  "gh_missing",
  "gh_auth",
  "not_github",
  "gh_failed",
  "draft_failed",
  "bad_sound",
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
  ptySpawn(id, cwd, profileId, account, cols, rows, onData) {
    // Rust sends raw bytes, which arrive as an ArrayBuffer.
    const out = new Channel<ArrayBuffer | number[]>();
    out.onmessage = (msg) => onData(toBytes(msg));
    return call("pty_spawn", { id, cwd, profileId, account, cols, rows, out });
  },
  ptyApprove: (profileId, account) => call("pty_approve", { profileId, account }),
  profiles: () => call("profiles_list"),
  profilePut: (profile) => call("profile_put", { profile }),
  profileRemove: (id) => call("profile_remove", { id }),
  profileReset: (id) => call("profile_reset", { id }),
  profilesDefaults: (approvals, defaultAgent, defaultShell) => call("profiles_defaults", { approvals, defaultAgent, defaultShell }),
  shellPut: (shell) => call("shell_put", { shell }),
  shellRemove: (id) => call("shell_remove", { id }),
  ptyWrite: (id, data) => call("pty_write", { id, data: [...data] }),
  ptyResize: (id, cols, rows) => call("pty_resize", { id, cols, rows }),
  ptyAck: (id, n) => call("pty_ack", { id, n }),
  ptyKill: (id) => call("pty_kill", { id }),
  onPtyExit: (cb) => listen<PtyExit>("pty://exit", (e) => cb(e.payload)),
  onPtyHook: (cb) => listen<PtyHook>("pty://hook", (e) => cb(e.payload)),
  statusSettings: () => call("status_settings_get"),
  statusSettingsPut: (settings) => call("status_settings_put", { settings }),
  statusNotify: (title, body, ptyId) => call("status_notify", { title, body, ptyId }),
  onStatusNotificationClick: (cb) => listen<{ ptyId: string }>("status://notification-click", (e) => cb(e.payload.ptyId)),
  statusBadge: (count) => call("status_badge", { count }),
  statusSoundSet: (path) => call("status_sound_set", { path }),
  statusSound: async () => {
    const bytes = await call<ArrayBuffer | number[] | null>("status_sound");
    return bytes === null ? null : new Uint8Array(bytes);
  },
  pickSoundFile: async () => {
    const picked = await open({ multiple: false, directory: false, filters: [{ name: "Sound", extensions: ["wav", "mp3", "ogg"] }] });
    return typeof picked === "string" ? picked : null;
  },
  workspaceList: () => call("workspace_list"),
  repoAdd: (path) => call("repo_add", { path }),
  repoForget: (id) => call("repo_forget", { id }),
  repoUpdate: (id, patch) => call("repo_update", { id, ...patch }),
  worktreeAdopt: (path) => call("worktree_adopt", { path }),
  vaultList: () => call("vault_list"),
  vaultAdd: (path) => call("vault_add", { path }),
  vaultForget: (id) => call("vault_forget", { id }),
  vaultCreateDocs: (repoId, file, content) => call("vault_create_docs", { repoId, file, content }),
  worktreeCreate: (repoId, name, from) => call("worktree_create", { repoId, name, from }),
  worktreePin: (path, pinned) => call("worktree_pin", { path, pinned }),
  worktreeRemove: (path, force, confirmed) => call("worktree_remove", { path, force, confirmed }),
  worktreeChanges: (path) => call("worktree_changes", { path }),
  worktreeFileDiff: (path, file) => call("worktree_file_diff", { path, file }),
  worktreeCommit: (path, files, message) => call("worktree_commit", { path, files, message }),
  worktreeStat: (path) => call("worktree_stat", { path }),
  worktreeShip: (path) => call("worktree_ship", { path }),
  worktreePush: (path) => call("worktree_push", { path }),
  worktreePull: (path) => call("worktree_pull", { path }),
  worktreeSync: (path) => call("worktree_sync", { path }),
  worktreeFetch: (path) => call("worktree_fetch", { path }),
  worktreeForcePush: (path, expected, confirmed) => call("worktree_force_push", { path, expected, confirmed }),
  worktreeAmend: (path, files, message, confirmed) => call("worktree_amend", { path, files, message, confirmed }),
  worktreePr: (path) => call("worktree_pr", { path }),
  worktreePrCreate: (path, draft) => call("worktree_pr_create", { path, draft }),
  worktreePrChecks: (path, number) => call("worktree_pr_checks", { path, number }),
  worktreePrOpen: (path, checks) => call("worktree_pr_open", { path, checks }),
  worktreeDraftCommit: (path, files) => call("worktree_draft_commit", { path, files }),
  worktreeDraftPr: (path) => call("worktree_draft_pr", { path }),
  worktreeListDir: (path, dir) => call("worktree_list_dir", { path, dir }),
  worktreeReview: (path, base) => call("worktree_review", { path, base }),
  worktreeReviewFile: (path, base, file) => call("worktree_review_file", { path, base, file }),
  worktreeStage: (path, files, staged) => call("worktree_stage", { path, files, staged }),
  worktreeBranches: (path) => call("worktree_branches", { path }),
  reviewNotes: (path) => call("review_notes_get", { path }),
  reviewNotesPut: (path, notes) => call("review_notes_put", { path, notes }),
  kitHomes: () => call("kit_homes"),
  kitSkills: (worktree) => call("kit_skills", { worktree }),
  kitMemory: (worktree) => call("kit_memory", { worktree }),
  kitRead: (path, worktree) => call("kit_read", { path, worktree }),
  kitWrite: (path, text, stamp, worktree) => call("kit_write", { path, text, stamp, worktree }),
  kitCopy: (from, to, worktree) => call("kit_copy", { from, to, worktree }),
  kitSkillCopy: (dir, toSkillsDir, worktree) => call("kit_skill_copy", { dir, toSkillsDir, worktree }),
  kitSkillNew: (skillsDir, name, description, worktree) => call("kit_skill_new", { skillsDir, name, description, worktree }),
  kitSkillRemove: (dir, worktree) => call("kit_skill_remove", { dir, worktree }),
  kitSkillRestore: (removed, to, worktree) => call("kit_skill_restore", { removed, to, worktree }),
  // The local offset (UTC+7 is 420) decides which day a log line belongs to.
  kitUsage: (sinceDay, untilDay, refresh) =>
    call("kit_usage", { sinceDay, untilDay, refresh, utcOffsetMinutes: -new Date().getTimezoneOffset() }),
  kitPathsExist: (root, paths) => call("kit_paths_exist", { root, paths }),
  kitPromptHistory: (limit) => call("kit_prompt_history", { limit }),
};

function browserApi(): Api {
  const params = new URLSearchParams(location.search);
  const mock = createMockApi(DEMO_SEED, { repo: !params.has("norepo"), commits: DEMO_COMMITS, runDelayMs: 4000 });
  // Lets the preview simulate an AI agent or another editor from the devtools console.
  Object.assign(window, { xdevMock: mock });
  // The preview lands in the demo vault so the main layout is reachable without a dialog;
  // `?welcome` simulates a first launch instead.
  const firstRun = params.has("welcome");
  // `?update=0.4.0` simulates a downloaded update, so the restart button can be previewed.
  const pending = params.get("update");
  let seeded = false;
  return {
    ...mock,
    updateStatus: async () => (pending ? { version: pending, notes: null } : null),
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
