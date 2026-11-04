import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Accounts,
  AccountSource,
  ActiveAccount,
  AgentsSettings,
  SwitchRunning,
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
  PtyAttached,
  PtyExit,
  PtyHook,
  PtyInfo,
  PtydStatus,
  SessionInfo,
  StatusSettings,
  SettingsChanged,
  TerminalSettings,
  KeySettings,
  KeybindingsChanged,
  KeybindingsText,
  UiSettings,
  OpenInSettings,
  OpenTarget,
  CloneProgress,
  CreateProject,
  Created,
  NamePreview,
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
  StageState,
  ConflictOp,
  ConflictState,
  WorktreeStat,
  WorktreeView,
  WorktreeCreated,
  Linked,
  DefaultTab,
  DetailsPatch,
  FolderEntry,
  Removed,
  SidebarItem,
  SidebarPrefs,
  Check,
  PrDraft,
  PrView,
  Issue,
  IssueComment,
  IssueDetail,
  IssueQuery,
  IssueState,
  ShipView,
  RepoHooks,
  HookKind,
  HookRun,
  SetupPolicy,
  ScriptSource,
  QuickCommand,
  FileCommands,
} from "@xdev/bindings";
import type {
  AgentSession,
  DirEntry,
  DirListing,
  DiffSettings,
  EditorSettings,
  Eol,
  FileHits,
  FileList,
  FileText,
  GitSettings,
  GitRecipes,
  Recipe,
  LineHit,
  Home,
  KitText,
  MemorySet,
  NavigationSettings,
  PromptEntry,
  SearchEvent,
  SearchQuery,
  SessionQuery,
  SessionRow,
  Agent,
  Skill,
  UsageSummary,
  WriteOutcome,
} from "@xdev/bindings";
import type { Target } from "./doc/frontmatter";
import type { LayoutSnapshot } from "./workspace/layoutSnapshot";
import { toBytes } from "./terminal/ptyClient";
import { createMockApi, DEMO_AI_EDIT, DEMO_COMMITS, DEMO_OUTSIDE_EDIT, DEMO_ROOT, DEMO_SEED } from "./mockApi";

export { createMockApi };
/** The kinds of `HookKind` that are scripts; the others are lists. */
export type ScriptKind = Extract<HookKind, "setup" | "archive">;
export type { Target };
export type { DirEntry, DirListing, Home, KitText, MemorySet, PromptEntry, Skill, UsageSummary };
export type { Agent, AgentSession, SessionQuery, SessionRow };
export type { DiffSettings, EditorSettings, Eol, NavigationSettings, FileText, WriteOutcome };
export type { AccountSource, ActiveAccount, AgentsSettings, SwitchRunning };
export type { FileHits, FileList, LineHit, SearchEvent, SearchQuery };
export type { FileKind } from "@xdev/bindings";
export type { RestoreMode } from "@xdev/bindings";
export type { SessionScope, SessionSort } from "@xdev/bindings";

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
  PtyAttached,
  PtyExit,
  PtyHook,
  PtyInfo,
  PtydState,
  PtydStatus,
  SessionInfo,
  OnQuit,
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
  StageState,
  ConflictOp,
  ConflictState,
  WorktreeSkip,
  WorktreeStat,
  WorktreeView,
  DetailsPatch,
  FolderEntry,
  KeptBranch,
  KeptReason,
  KeptView,
  MadeBy,
  RepoGroup,
  Removed,
  SidebarItem,
  SidebarPrefs,
  WorkItem,
  WorkItemKind,
  WorkStatus,
  Check,
  PrDraft,
  PrView,
  Issue,
  IssueComment,
  IssueDetail,
  IssueQuery,
  IssueState,
  ShipView,
  GitSettings,
  GitRecipes,
  Recipe,
  BranchPrefixMode,
  TerminalSettings,
  FontWeight,
  CursorStyle,
  SettingsSection,
  SettingsChanged,
  SetupPolicy,
  ScriptSource,
  HookKind,
  HookScript,
  RepoHooks,
  DefaultTab,
  Linked,
  WorktreeCreated,
  HookRun,
  KeySettings,
  TerminalKeyPolicy,
  UiSettings,
  KeybindingsText,
  QuickCommand,
  QuickScope,
  QuickAction,
  FileCommand,
  FileCommands,
  OpenInApp,
  OpenInSettings,
  OpenTarget,
  CloneProgress,
  CreateProject,
  Created,
  NamePreview,
  ProjectKind,
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
  | "session_missing"
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
  | "pty_gone"
  | "ptyd_unreachable"
  | "ptyd_auth"
  | "ptyd_version"
  | "ptyd_start_failed"
  | "bad_arg"
  | "unknown_profile"
  | "registry_corrupt"
  | "repo_exists"
  | "repo_unknown"
  | "worktree_unknown"
  | "worktree_exists"
  | "branch_exists"
  | "bad_branch_prefix"
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
  | "issue_not_found"
  | "issue_other_repo"
  | "draft_failed"
  | "unsupported_agent"
  | "bad_sound"
  | "hook_untrusted"
  | "hook_none"
  | "setup_skipped"
  | "cancelled"
  | "bad_details"
  | "bad_parent"
  | "bad_item"
  | "kept_unknown"
  | "group_unknown"
  | "folder_unknown"
  | "folder_exists"
  | "branch_pushed"
  | "no_conflict"
  | "still_conflicted";
export type ApiError = Omit<CmdError, "code"> & { code: ErrorCode };

export type RepoPatch = {
  shortName?: string;
  baseRef?: string;
  worktreeRoot?: string;
  setupPolicy?: SetupPolicy;
  scriptSource?: ScriptSource;
  localSetup?: string;
  localArchive?: string;
  // A folder relative to the primary checkout; "" goes back to the default "docs".
  docsDir?: string;
};

// The `ptySpawn` profile id that runs the worktree's setup script in the default shell. Rejects
// with `setup_skipped` when the repo's setup policy is skip, `hook_none` when there is no setup and
// `hook_untrusted` when its shared part is not trusted.
export const SETUP_PROFILE = "xdev:setup";

export { QUICK_COMMAND_LIMITS } from "./quickCommands/limits";

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
  // Makes `name` the active account of `provider`; null goes back to the CLI's own home.
  // Running tabs are left as they are; see `workspace/accountSwitch.ts`.
  accountActivate(provider: Provider, name: string | null): Promise<void>;
  // Copies the log of agent session `session` from account `from`'s home to `to`'s (null: the
  // CLI's own home) so a restarted tab resumes it; false when `to` already has it,
  // `session_missing` when `from` has no such log.
  accountCarrySession(provider: Provider, from: string | null, to: string | null, session: string, cwd: string): Promise<boolean>;
  // `accounts://changed`: after an account is added, removed or made active.
  onAccountsChanged(cb: () => void): Promise<() => void>;
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
  // Settings → Git, stored in the app settings file. `setGitSettings` returns what was stored,
  // with the custom prefix normalized.
  gitSettings(): Promise<GitSettings>;
  setGitSettings(git: GitSettings): Promise<GitSettings>;
  // Settings -> Terminal; the put returns what was stored, with numbers clamped to their ranges.
  terminalSettings(): Promise<TerminalSettings>;
  terminalSettingsPut(s: TerminalSettings): Promise<TerminalSettings>;
  /** Calls `listener` after any settings write, from this window or another. Returns the unsubscribe. */
  onSettingsChanged(listener: (e: SettingsChanged) => void): () => void;
  // Window view settings (zoom, 0.5..2); the put returns what was stored, clamped.
  uiSettingsGet(): Promise<UiSettings>;
  uiSettingsPut(s: UiSettings): Promise<UiSettings>;
  // Keys. `keybindings.json` in the app config folder holds the shortcut overrides; Rust only moves
  // the text, `keys/keybindingsFile.ts` parses it. `text` is null when there is no file.
  keybindingsRead(): Promise<KeybindingsText>;
  // Replaces the whole file; rejects with `bad_arg` past 1 MiB.
  keybindingsWrite(text: string): Promise<void>;
  // Opens the folder, writing an empty version-1 file first when there is none.
  keybindingsReveal(): Promise<void>;
  // After our own write and when the file changes on disk.
  onKeybindingsChanged(fn: (text: string | null) => void): Promise<() => void>;
  // The terminal policy and the hint toggle (settings.json `keys`); the put returns what was stored.
  keySettingsGet(): Promise<KeySettings>;
  keySettingsPut(s: KeySettings): Promise<KeySettings>;
  // The global git `user.name` the git-username prefix shows; `null` when none is set.
  gitUserName(): Promise<string | null>;
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
  // `resume` is an agent session id (A-Z, a-z, 0-9, `_`, `-`): the CLI continues that session.
  ptySpawn(id: string, cwd: string, profileId: PtyProfile, account: string | null, cols: number, rows: number, onData: (bytes: Uint8Array) => void, resume?: string): Promise<PtyInfo>;
  // Approves the launch `ptySpawn` was refused for; pass the same `resume`, as it is part of the launch line.
  ptyApprove(profileId: PtyProfile, account: string | null, resume?: string): Promise<void>;
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
  // Reattaches a tab to the terminal service's pty `id`: output from byte `fromSeq` on arrives on
  // `onData`, then the live output. Rejects with `pty_gone` when the service does not hold it.
  ptyAttach(id: string, fromSeq: number, onData: (bytes: Uint8Array) => void): Promise<PtyAttached>;
  // Where terminals run: `off` (in the app), `running` (the service), `fallback`, `old-version`.
  ptydStatus(): Promise<PtydStatus>;
  // Every pty the service holds, attached or not.
  ptydSessions(): Promise<SessionInfo[]>;
  ptydEnd(id: string): Promise<void>;
  ptydEndAll(): Promise<void>;
  // Ends the service and every pty in it, then starts it again (Retry after a fallback).
  ptydRestart(): Promise<void>;
  // The answer to "On quit: Ask", given before the window closes: true ends every pty.
  ptydQuitChoice(end: boolean): Promise<void>;
  onPtydStatus(cb: (s: PtydStatus) => void): Promise<() => void>;
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
  // Open in. Settings → Open In Apps; the put rejects with `bad_arg` (at most 8 apps, unique ids,
  // label 1..=40 chars, command 1..=260 chars without arguments, at most 8 args of 200 chars) and
  // returns what was stored.
  openInSettings(): Promise<OpenInSettings>;
  openInSettingsPut(v: OpenInSettings): Promise<OpenInSettings>;
  // Opens a known repo or worktree folder in an Open In app or the file manager. Rejects with
  // `worktree_unknown`, `not_found` (no such app id, or its program is missing; the detail names
  // it), `needs_approval` / `denied` from the policy.
  openIn(path: string, target: OpenTarget): Promise<void>;
  // Clones `url` into `parent/name` (the name from the URL when null) and adds it as a repo; the
  // events end with `done` or `error`. `id` names the run for `repoCloneCancel`. Rejects with
  // `bad_arg` for a refused URL, `exists` when the folder is there, `cancelled` after a cancel; a
  // partly cloned folder goes to the trash.
  repoClone(url: string, parent: string, name: string | null, id: string, onEvent: (e: CloneProgress) => void): Promise<void>;
  repoCloneCancel(id: string): Promise<void>;
  // The folder name a clone gets: `xdev` for `https://host/a/xdev.git`; `bad_arg` when there is none.
  repoCloneName(url: string): Promise<string>;
  // Makes `parent/name` and lists it: a Git project is `git init`-ed (branch `req.branch`, empty =
  // `main`), gets an empty first commit when `req.firstCommit`, and is added like a checkout; a
  // plain folder is added as a sidebar folder. Rejects with `bad_name` (name or branch), `exists`
  // (the target is there and not an empty folder), `not_found` (no parent), and `git_identity`
  // when the first commit needs a `user.name` / `user.email`: the folder and `.git` stay and nothing
  // is added.
  repoCreate(req: CreateProject): Promise<Created>;
  // The setup and archive scripts of a worktree: `xdev.toml` in it (else in the primary checkout)
  // joined with the repo's local scripts by its script source. A bad file is `parseError`, not a rejection.
  repoHooks(path: string): Promise<RepoHooks>;
  // Trusts the shared script of `kind` with this hash; `hook_untrusted` when the file changed since.
  repoHookTrust(path: string, kind: HookKind, hash: string): Promise<RepoHooks>;
  // Runs the archive script headless (120 s, 64 KiB of output); `ran: false` when there is none.
  // Rejects with `hook_untrusted`.
  worktreeArchiveRun(path: string): Promise<HookRun>;
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
  // base ref. A taken name is made as `name-2`, `-3`, … (the title keeps what was typed). Rejects
  // with `bad_name`, `branch_exists` (99 taken), `worktree_exists` or `bad_ref`, and with
  // `bad_branch_prefix` when Settings → Git holds a custom prefix no branch name can start with.
  worktreeCreate(repoId: string, name: string, from: string | null): Promise<WorktreeCreated>;
  // What `worktreeCreate` would name the branch and folder for a typed name, without making
  // anything; `suffixed` when the name was taken and got `-2`, `-3`, …
  worktreeNamePreview(repoId: string, name: string): Promise<NamePreview>;
  worktreePin(path: string, pinned: boolean): Promise<void>;
  // Rejects with `needs_approval` until `confirmed`, then with `worktree_dirty` for uncommitted
  // work until `force`, and with `primary_worktree` for the main checkout. A branch made here and
  // merged (or any with `force`) is deleted; otherwise it is kept and listed for review.
  worktreeRemove(path: string, force: boolean, confirmed: boolean): Promise<Removed>;
  // Removes the folder and keeps the branch, listed under Archived. The same gate and dirty check as
  // `worktreeRemove`; a detached worktree rejects with `detached` until `force`.
  worktreeArchive(path: string, force: boolean, confirmed: boolean): Promise<Removed>;
  // Only the keys given change; `null` clears. Rejects with `bad_details` (title over 120 or comment
  // over 2000 chars), `bad_parent`, `bad_item`, `primary_worktree`, `worktree_unknown`.
  worktreeDetails(path: string, patch: DetailsPatch): Promise<void>;
  // Brings a kept branch back as a worktree at its old path, or a free one beside it, with its
  // details. Rejects with `kept_unknown` when the entry or the branch is gone.
  worktreeRestore(repoId: string, branch: string): Promise<WorktreeView>;
  // Stops listing a kept branch; the branch stays in git. Rejects with `kept_unknown`.
  keptKeep(repoId: string, branch: string): Promise<void>;
  // Deletes a kept branch from git. Rejects with `needs_approval` until `confirmed`, `kept_unknown`.
  branchDelete(repoId: string, branch: string, confirmed: boolean): Promise<void>;
  // Repos (with their kept branches), plain folders and groups in shown order.
  workspaceSidebar(): Promise<SidebarItem[]>;
  // The top-level order; unknown ids are skipped and items left out follow in the order added.
  sidebarOrder(ids: string[]): Promise<void>;
  // Creates a group (`id` null) or renames one; returns its id. Rejects with `bad_name`, `group_unknown`.
  groupPut(id: string | null, name: string): Promise<string>;
  // Its members take its place at the top level. Rejects with `group_unknown`.
  groupRemove(id: string): Promise<void>;
  // Moves a repo or folder into `group` (top level when null) at `index`. Rejects with
  // `repo_unknown` for an unknown member, `group_unknown`.
  groupMove(member: string, group: string | null, index: number): Promise<void>;
  // Lists a plain folder. Rejects with `not_found`, and `folder_exists` for a repo, a worktree or a
  // folder already listed.
  folderAdd(path: string): Promise<FolderEntry>;
  // Only the entry goes; nothing on disk is touched. Rejects with `folder_unknown`.
  folderForget(id: string): Promise<void>;
  // The sidebar's filters (Settings `sidebar`); the put returns what was stored.
  sidebarPrefsGet(): Promise<SidebarPrefs>;
  sidebarPrefsPut(prefs: SidebarPrefs): Promise<SidebarPrefs>;
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
  // GitHub issues of a repo through `gh`, read in its main checkout. Reject with the `gh_*` codes,
  // `not_github`, `issue_not_found`, or `issue_other_repo` (resolve only).
  issuesList(repoId: string, query: IssueQuery): Promise<Issue[]>;
  issueView(repoId: string, number: number): Promise<IssueDetail>;
  // `#12`, `12` or an issue URL of this repo; null when the text names no issue.
  issueResolve(repoId: string, text: string): Promise<Issue | null>;
  // Opens the issue in the browser through `gh`.
  issueOpen(repoId: string, number: number): Promise<void>;
  // The log of the failed job behind a check's link (capped), for the Fix checks recipe; null when
  // `gh` cannot give it.
  worktreeCheckLog(path: string, link: string): Promise<string | null>;
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
  worktreeStageState(path: string): Promise<StageState[]>;
  worktreeDiscard(path: string, files: string[], stagedToo: boolean, confirmed: boolean): Promise<void>;
  // Renames the worktree's branch to `<prefix>/<name>` (`-2`, `-3`, … when taken); the folder stays.
  // Rejects with `branch_pushed` (it has an upstream), `detached`, `bad_name` or `branch_exists`.
  worktreeRenameBranch(path: string, name: string): Promise<WorktreeView>;
  // A name for the work of an agent session (the worktree's latest when null), from the Branch name
  // recipe, or the first words of the prompt when the recipe's agent cannot answer; changes nothing.
  // Rejects with `bad_name` when the session has no usable prompt.
  worktreeSuggestBranch(path: string, session: string | null): Promise<string>;
  // The merge, rebase, cherry-pick or revert in progress; null when there is none.
  worktreeConflicts(path: string): Promise<ConflictState | null>;
  // Finishes it; rejects with `still_conflicted` while a file is unmerged, `no_conflict` with nothing
  // in progress.
  worktreeConflictContinue(path: string): Promise<void>;
  // Gives it up and drops the resolution work; gated like a discard (`confirmed`).
  worktreeConflictAbort(path: string, confirmed: boolean): Promise<void>;
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

  // Agent sessions
  // The agent sessions of every home, matched to the workspace; `refresh` reads the new log
  // bytes first. Rejects with `bad_arg` when `query.limit` is over 500.
  agentSessions(query: SessionQuery, refresh: boolean): Promise<SessionRow[]>;

  // Quick commands
  // Every saved command (settings.json `quickCommands`), global and per repo together, in order.
  quickCommandsList(): Promise<QuickCommand[]>;
  // An empty `id` gets a new `qc-…` one and goes at the end of its scope; a known id is replaced in
  // place. Resolves with what was stored (label trimmed, command end-trimmed, repo as the workspace
  // lists it). Rejects with `bad_arg` and the field in `detail`: `label`, `command`, `prompt`,
  // `profile` (not an agent profile), `repo` (not in the workspace) or `prompts` (all prompts over
  // `QUICK_COMMAND_LIMITS.promptsTotalBytes`). Every change fires `settings://changed` with `quickCommands`.
  quickCommandUpsert(item: QuickCommand): Promise<QuickCommand>;
  // An unknown id is a no-op. Also drops the id from the recent list.
  quickCommandDelete(id: string): Promise<void>;
  // Moves the command to index `to` among the commands of its own scope (clamped). Rejects with
  // `not_found` for an unknown id.
  quickCommandsMove(id: string, to: number): Promise<void>;
  // The `[[commands]]` of the worktree's `xdev.toml` (else the primary checkout's), read only. Bad
  // entries and a file that does not parse are in `errors`. Rejects with `worktree_unknown`.
  repoFileCommands(worktree: string): Promise<FileCommands>;
  // Trusts those commands with this hash; `hook_untrusted` when the file changed since.
  repoFileCommandsTrust(worktree: string, hash: string): Promise<FileCommands>;
  // Records a run: the id moves to the front of the recent list. An unknown id is a no-op.
  quickCommandUsed(id: string): Promise<void>;
  // Recently run ids, newest first, at most `QUICK_COMMAND_LIMITS.recent`.
  quickCommandsRecent(): Promise<string[]>;
  // Files. `worktree` is a repo or worktree the workspace knows (any other rejects with
  // `worktree_unknown`); `rel` is relative to it with forward slashes. `..`, an absolute path, a
  // link or `.git` rejects with `bad_path`.
  // The text, or `text: null` with `kind` `binary` or `tooLarge` (over 2 MiB, nothing read).
  // Rejects with `not_found`.
  fileRead(worktree: string, rel: string): Promise<FileText>;
  // Saves when the file still has the `expected` hash (null: the file must not exist yet), with
  // every line break in `text` written as `eol`. Otherwise resolves `conflict` and writes nothing.
  fileWrite(worktree: string, rel: string, text: string, eol: Eol, expected: string | null): Promise<WriteOutcome>;
  // An empty file or a folder; its parent must exist. Rejects with `exists`.
  fileCreate(worktree: string, rel: string, dir: boolean): Promise<void>;
  // Within the worktree; a change of case only is allowed. Rejects with `exists`.
  fileRename(worktree: string, from: string, to: string): Promise<void>;
  // Moves the item to the OS trash after the policy gate; rejects with `denied` or `needs_approval`.
  fileTrash(worktree: string, rel: string): Promise<void>;
  // Opens the OS file manager with the item selected where the OS allows it.
  fileReveal(worktree: string, rel: string): Promise<void>;
  // Search. Same `worktree` rule as Files. Both walk the worktree with `.gitignore` applied,
  // hidden files included, `.git` and links out of it skipped.
  // Every file, relative with forward slashes, sorted; `truncated` past 50 000 files.
  filesList(worktree: string): Promise<FileList>;
  // Searches the text files (binary files and files over 2 MiB are skipped). `onEvent` gets
  // `batch` events, then one `done`; a bad regex or glob sends one `error` instead. At most
  // 5 000 lines in total and 200 per file (`more`). A new search with the same `id` cancels the
  // old one, which sends nothing more. Resolves when the search ends or is cancelled.
  filesSearch(worktree: string, query: SearchQuery, id: string, onEvent: (e: SearchEvent) => void): Promise<void>;
  // Stops the search named `id`; nothing when it is not running.
  filesSearchCancel(id: string): Promise<void>;
  // Settings → Editor; the put returns what was stored, with numbers clamped to their ranges.
  editorSettings(): Promise<EditorSettings>;
  editorSettingsPut(v: EditorSettings): Promise<EditorSettings>;
  // Settings → General: Navigation and Diff; each put returns what was stored.
  navigationSettings(): Promise<NavigationSettings>;
  navigationSettingsPut(v: NavigationSettings): Promise<NavigationSettings>;
  diffSettings(): Promise<DiffSettings>;
  diffSettingsPut(v: DiffSettings): Promise<DiffSettings>;
  // Settings → Agents; the put returns what was stored.
  agentsSettings(): Promise<AgentsSettings>;
  agentsSettingsPut(v: AgentsSettings): Promise<AgentsSettings>;

  // Layout
  // The tabs and splits saved for the next start (`<data_dir>/layout.json`); null when none is saved
  // or the file does not parse (it is kept as `layout.json.bad`).
  layoutLoad(): Promise<LayoutSnapshot | null>;
  // Replaces the saved layout. Rejects with `bad_arg` when `version` is not `LAYOUT_VERSION` and
  // `too_large` past 1 MiB.
  layoutSave(snapshot: LayoutSnapshot): Promise<void>;
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
  "session_missing",
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
  "pty_gone",
  "ptyd_unreachable",
  "ptyd_auth",
  "ptyd_version",
  "ptyd_start_failed",
  "bad_arg",
  "unknown_profile",
  "registry_corrupt",
  "repo_exists",
  "repo_unknown",
  "worktree_unknown",
  "worktree_exists",
  "branch_exists",
  "bad_branch_prefix",
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
  "issue_not_found",
  "issue_other_repo",
  "draft_failed",
  "unsupported_agent",
  "bad_sound",
  "hook_untrusted",
  "hook_none",
  "setup_skipped",
  "cancelled",
  "bad_details",
  "bad_parent",
  "bad_item",
  "kept_unknown",
  "group_unknown",
  "folder_unknown",
  "folder_exists",
  "branch_pushed",
  "no_conflict",
  "still_conflicted",
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
  accountActivate: (provider, name) => call("account_activate", { provider, name }),
  accountCarrySession: (provider, from, to, session, cwd) => call("account_carry_session", { provider, from, to, session, cwd }),
  onAccountsChanged: (cb) => listen("accounts://changed", () => cb()),
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
  gitSettings: () => call("git_settings"),
  setGitSettings: (git) => call("set_git_settings", { git }),
  terminalSettings: () => call("terminal_settings_get"),
  terminalSettingsPut: (settings) => call("terminal_settings_put", { settings }),
  onSettingsChanged: (listener) => {
    const unlisten = listen<SettingsChanged>("settings://changed", (e) => listener(e.payload));
    return () => void unlisten.then((stop) => stop());
  },
  uiSettingsGet: () => call("ui_settings_get"),
  uiSettingsPut: (settings) => call("ui_settings_put", { settings }),
  keybindingsRead: () => call("keybindings_read"),
  keybindingsWrite: (text) => call("keybindings_write", { text }),
  keybindingsReveal: () => call("keybindings_reveal"),
  onKeybindingsChanged: (fn) => listen<KeybindingsChanged>("keybindings://changed", (e) => fn(e.payload.text)),
  keySettingsGet: () => call("key_settings_get"),
  keySettingsPut: (settings) => call("key_settings_put", { settings }),
  gitUserName: () => call("git_user_name"),
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
  ptySpawn(id, cwd, profileId, account, cols, rows, onData, resume) {
    // Rust sends raw bytes, which arrive as an ArrayBuffer.
    const out = new Channel<ArrayBuffer | number[]>();
    out.onmessage = (msg) => onData(toBytes(msg));
    return call("pty_spawn", { id, cwd, profileId, account, cols, rows, out, resume: resume ?? null });
  },
  ptyApprove: (profileId, account, resume) => call("pty_approve", { profileId, account, resume: resume ?? null }),
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
  ptyAttach(id, fromSeq, onData) {
    const out = new Channel<ArrayBuffer | number[]>();
    out.onmessage = (msg) => onData(toBytes(msg));
    return call("pty_attach", { id, fromSeq, out });
  },
  ptydStatus: () => call("ptyd_status"),
  ptydSessions: () => call("ptyd_sessions"),
  ptydEnd: (id) => call("ptyd_end", { id }),
  ptydEndAll: () => call("ptyd_end_all"),
  ptydRestart: () => call("ptyd_restart"),
  ptydQuitChoice: (end) => call("ptyd_quit_choice", { end }),
  onPtydStatus: (cb) => listen<PtydStatus>("ptyd://status", (e) => cb(e.payload)),
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
  openInSettings: () => call("open_in_settings"),
  openInSettingsPut: (v) => call("open_in_settings_put", { v }),
  openIn: (path, target) => call("open_in", { path, target }),
  repoClone(url, parent, name, id, onEvent) {
    const channel = new Channel<CloneProgress>();
    channel.onmessage = onEvent;
    return call("repo_clone", { url, parent, name, id, onEvent: channel });
  },
  repoCloneCancel: (id) => call("repo_clone_cancel", { id }),
  repoCloneName: (url) => call("repo_clone_name", { url }),
  repoCreate: (req) => call("repo_create", { req }),
  repoUpdate: (id, patch) => call("repo_update", { id, ...patch }),
  repoHooks: (path) => call("repo_hooks", { path }),
  repoHookTrust: (path, kind, hash) => call("repo_hook_trust", { path, kind, hash }),
  worktreeArchiveRun: (path) => call("worktree_archive_run", { path }),
  worktreeAdopt: (path) => call("worktree_adopt", { path }),
  vaultList: () => call("vault_list"),
  vaultAdd: (path) => call("vault_add", { path }),
  vaultForget: (id) => call("vault_forget", { id }),
  vaultCreateDocs: (repoId, file, content) => call("vault_create_docs", { repoId, file, content }),
  worktreeCreate: (repoId, name, from) => call("worktree_create", { repoId, name, from }),
  worktreeNamePreview: (repoId, name) => call("worktree_name_preview", { repoId, name }),
  worktreePin: (path, pinned) => call("worktree_pin", { path, pinned }),
  worktreeRemove: (path, force, confirmed) => call("worktree_remove", { path, force, confirmed }),
  worktreeArchive: (path, force, confirmed) => call("worktree_archive", { path, force, confirmed }),
  worktreeDetails: (path, patch) => call("worktree_details", { path, patch }),
  worktreeRestore: (repoId, branch) => call("worktree_restore", { repoId, branch }),
  keptKeep: (repoId, branch) => call("kept_keep", { repoId, branch }),
  branchDelete: (repoId, branch, confirmed) => call("branch_delete", { repoId, branch, confirmed }),
  workspaceSidebar: () => call("workspace_sidebar"),
  sidebarOrder: (ids) => call("sidebar_order", { ids }),
  groupPut: (id, name) => call("group_put", { id, name }),
  groupRemove: (id) => call("group_remove", { id }),
  groupMove: (member, group, index) => call("group_move", { member, group, index }),
  folderAdd: (path) => call("folder_add", { path }),
  folderForget: (id) => call("folder_forget", { id }),
  sidebarPrefsGet: () => call("sidebar_prefs_get"),
  sidebarPrefsPut: (prefs) => call("sidebar_prefs_put", { prefs }),
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
  issuesList: (repoId, query) => call("issues_list", { repoId, query }),
  issueView: (repoId, number) => call("issue_view", { repoId, number }),
  issueResolve: (repoId, text) => call("issue_resolve", { repoId, text }),
  issueOpen: (repoId, number) => call("issue_open", { repoId, number }),
  worktreeCheckLog: (path, link) => call("worktree_check_log", { path, link }),
  worktreeDraftCommit: (path, files) => call("worktree_draft_commit", { path, files }),
  worktreeDraftPr: (path) => call("worktree_draft_pr", { path }),
  worktreeListDir: (path, dir) => call("worktree_list_dir", { path, dir }),
  worktreeReview: (path, base) => call("worktree_review", { path, base }),
  worktreeReviewFile: (path, base, file) => call("worktree_review_file", { path, base, file }),
  worktreeStage: (path, files, staged) => call("worktree_stage", { path, files, staged }),
  worktreeBranches: (path) => call("worktree_branches", { path }),
  worktreeStageState: (path) => call("worktree_stage_state", { path }),
  worktreeDiscard: (path, files, stagedToo, confirmed) => call("worktree_discard", { path, files, stagedToo, confirmed }),
  worktreeRenameBranch: (path, name) => call("worktree_rename_branch", { path, name }),
  worktreeSuggestBranch: (path, session) => call("worktree_suggest_branch", { path, session }),
  worktreeConflicts: (path) => call("worktree_conflicts", { path }),
  worktreeConflictContinue: (path) => call("worktree_conflict_continue", { path }),
  worktreeConflictAbort: (path, confirmed) => call("worktree_conflict_abort", { path, confirmed }),
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
  agentSessions: (query, refresh) => call("agent_sessions", { query, refresh }),
  quickCommandsList: () => call("quick_commands_list"),
  quickCommandUpsert: (item) => call("quick_command_upsert", { item }),
  quickCommandDelete: (id) => call("quick_command_delete", { id }),
  quickCommandsMove: (id, to) => call("quick_commands_move", { id, to }),
  repoFileCommands: (worktree) => call("repo_file_commands", { worktree }),
  repoFileCommandsTrust: (worktree, hash) => call("repo_file_commands_trust", { worktree, hash }),
  quickCommandUsed: (id) => call("quick_command_used", { id }),
  quickCommandsRecent: () => call("quick_commands_recent"),
  fileRead: (worktree, rel) => call("file_read", { worktree, rel }),
  fileWrite: (worktree, rel, text, eol, expected) => call("file_write", { worktree, rel, text, eol, expected }),
  fileCreate: (worktree, rel, dir) => call("file_create", { worktree, rel, dir }),
  fileRename: (worktree, from, to) => call("file_rename", { worktree, from, to }),
  fileTrash: (worktree, rel) => call("file_trash", { worktree, rel }),
  fileReveal: (worktree, rel) => call("file_reveal", { worktree, rel }),
  filesList: (worktree) => call("files_list", { worktree }),
  filesSearch(worktree, query, id, onEvent) {
    const channel = new Channel<SearchEvent>();
    channel.onmessage = onEvent;
    return call("files_search", { worktree, query, id, onEvent: channel });
  },
  filesSearchCancel: (id) => call("files_search_cancel", { id }),
  editorSettings: () => call("editor_settings_get"),
  editorSettingsPut: (settings) => call("editor_settings_put", { settings }),
  navigationSettings: () => call("navigation_settings_get"),
  navigationSettingsPut: (settings) => call("navigation_settings_put", { settings }),
  diffSettings: () => call("diff_settings_get"),
  diffSettingsPut: (settings) => call("diff_settings_put", { settings }),
  agentsSettings: () => call("agents_settings_get"),
  agentsSettingsPut: (settings) => call("agents_settings_put", { settings }),
  layoutLoad: () => call("layout_load"),
  layoutSave: (snapshot) => call("layout_save", { snapshot }),
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
