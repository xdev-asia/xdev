import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ConfigExported,
  EnvPreviewRow,
  RepoEnvVar,
  ImportApplied,
  ImportPreview,
  Accounts,
  AccountSource,
  ActiveAccount,
  AgentsSettings,
  SparsePreset,
  OrchestrationSettings,
  SkillStatus,
  WorkerLifetime,
  WorkerOpen,
  WorkerOpenOutcome,
  WorkerClose,
  ReadTab,
  WorkerChanged,
  AwakeView,
  AppStatsView,
  ResourceRow,
  ResourceSnapshot,
  PortScan,
  HostSource,
  LocalForward,
  SshHost,
  SshSyncReport,
  SshAuthPrompt,
  SshConnState,
  SshConnectionView,
  SshPromptKind,
  SshTestOutcome,
  KeepAwake,
  SwitchRunning,
  Approvals,
  DefaultAgent,
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
  LaunchOverrides,
  LaunchVerdict,
  Provider,
  PtyAttached,
  PtyExit,
  PtyHook,
  PtyInfo,
  PtydStatus,
  SessionInfo,
  StatusSettings,
  SoundName,
  NotificationPermission,
  SettingsChanged,
  TerminalSettings,
  KeySettings,
  KeybindingsChanged,
  KeybindingsText,
  UiSettings,
  CustomScheme,
  ConfigKind,
  TermConfigDetected,
  TermConfigPreview,
  OnNameTaken,
  SchemePreview,
  OpenInSettings,
  OpenTarget,
  CloneProgress,
  NestedRepo,
  NestedScanResult,
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
  UpdatePhase,
  UpdateChannel,
  UpdateDeferral,
  ReleaseBuild,
  ReleaseList,
  ShellSettings,
  ShellLabels,
  CloseIntent,
  CloseRequest,
  QuitMode,
  HelpLink,
  MenuAction,
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
  Note,
  ContextUsage,
  StageState,
  ConflictOp,
  ConflictState,
  ConflictEntry,
  ConflictKind,
  ConflictResolution,
  ForkSync,
  ForkSyncBlock,
  ForkSyncStatus,
  LineCount,
  BaseRange,
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
  SidebarGroupBy,
  SidebarSort,
  ProjectOrder,
  CardProps,
  Check,
  GhAccount,
  GhLogin,
  RepoIcon,
  PrDraft,
  PrView,
  PrState,
  PrComment,
  PrComments,
  PrCommentKind,
  PrCommentDraft,
  PrReaction,
  Reaction,
  MergeMethod,
  MergeBlock,
  PrMergeInfo,
  RerunReport,
  Issue,
  IssueComment,
  IssueDetail,
  IssueQuery,
  IssueState,
  IssueDraft,
  IssueEdit,
  IssueEditReport,
  IssueCloseReason,
  IssueLabel,
  IssueEvent,
  IssueEventKind,
  IssuesPreset,
  PrSummary,
  MrSummary,
  MrState,
  PrBranch,
  PrFilter,
  PrQuery,
  ProjectSummary,
  CreateRequest,
  ShipView,
  RepoLog,
  LogCommit,
  CommitRef,
  RefKind,
  LogRef,
  CommitFiles,
  CommitFile,
  CommitFileStatus,
  PullPolicy,
  RepoHooks,
  HookKind,
  HookRun,
  SetupPolicy,
  ScriptSource,
  QuickCommand,
  FileCommands,
  TerminalSet,
  SetEntry,
  SetTarget,
  SetWorktree,
  SequenceStep,
  StepWait,
  StartupPreset,
  CliAsk,
  CliOpenFile,
  CliOpenTab,
  TabReport,
  CrashDetail,
  CrashReport,
  CliStatus,
  McpActivityView,
  McpHealth,
  McpToolView,
  DiagnosticsExport,
  RenderCrash,
  StartupReport,
  StartupStep,
  XdevIdState,
  XdevIdServer,
  FsChanged,
  PathEntry,
} from "@xdev/bindings";
import type {
  Automation,
  AutomationDispatch,
  AutomationInput,
  AutomationRun,
  AutomationsChanged,
  AutomationsSettings,
  AutomationsView,
  NetworkSettings,
  Describe,
  DispatchResult,
  RunFinish,
  RunRow,
  RunTotals,
  RunUsage,
  RunsRange,
  RunsSummary,
  ScheduleProblem,
} from "@xdev/bindings";
export type {
  Automation,
  AutomationDispatch,
  AutomationInput,
  AutomationRun,
  AutomationsChanged,
  AutomationsSettings,
  AutomationsView,
  NetworkSettings,
  Describe,
  DispatchResult,
  ExtraArgsError,
  FailureCode,
  OutputSnapshot,
  Precheck,
  PrecheckResult,
  RunFinish,
  RunRow,
  RunTotals,
  RunUsage,
  RunsRange,
  RunsSummary,
  RunStatus,
  RunTrigger,
  ScheduleProblem,
  SetupDecision,
  WorkspaceMode,
} from "@xdev/bindings";
import type {
  AgentSession,
  AiKeyStatus,
  DirEntry,
  DirListing,
  DiffSettings,
  EditorSettings,
  Eol,
  FileHits,
  FileList,
  FileText,
  GitSettings,
  SourceControlGroupOrder,
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
  SessionSearchStatus,
  SessionTurn,
  SkippedLogs,
  Agent,
  Cost,
  Skill,
  UsageDisplay,
  UsageReport,
  UsageReportArgs,
  UsageScope,
  UsageSettings,
  ProviderSwitches,
  UsageSummary,
  WriteOutcome,
} from "@xdev/bindings";
import type { Target } from "./doc/frontmatter";
import type { LayoutSnapshot } from "./workspace/layoutSnapshot";
import { toBytes } from "./terminal/ptyClient";
import { createMockApi, DEMO_AI_EDIT, DEMO_COMMITS, DEMO_OUTSIDE_EDIT, DEMO_ROOT, DEMO_SEED } from "./mockApi";
import type { AccountRouting, QuotaAlert } from "@xdev/bindings";
import type { FailedOver, WorkerFailover } from "@xdev/bindings";

export { createMockApi };
/** The kinds of `HookKind` that are scripts; the others are lists. */
/** What the person agreed to before a port stop. */
export type PortStopConsent = { confirmed: boolean; outsideTerminal: boolean };

export type ScriptKind = Extract<HookKind, "setup" | "archive">;
export type { Target };
export type { DirEntry, DirListing, Home, KitText, MemorySet, PromptEntry, Skill, UsageSummary };
export type { Agent, AgentSession, Cost, SessionQuery, SessionRow, SessionSearchStatus, SessionTurn, SkippedLogs };
export type { DiffSettings, EditorSettings, Eol, NavigationSettings, FileText, WriteOutcome };
export type { ResourceRow, ResourceSnapshot };
export type { AccountSource, ActiveAccount, AgentsSettings, AppStatsView, AwakeView, KeepAwake, SwitchRunning };
export type { PortEvidence, PortKind, PortProtocol, PortScan, WorkspacePort } from "@xdev/bindings";
export type { HostSource, LocalForward, SshAuthPrompt, SshConnState, SshConnectionView, SshHost, SshPromptKind, SshSyncReport, SshTestOutcome };
export type { ProviderSwitches, UsageDisplay, UsageReport, UsageReportArgs, UsageScope, UsageSettings };
export type { ConfigExported, EnvPreviewRow, ImportApplied, ImportPreview, RepoEnvVar } from "@xdev/bindings";
export type { SectionPreview, ConfigChange } from "@xdev/bindings";
export type { FileHits, FileList, LineHit, SearchEvent, SearchQuery };
export type { FsChanged, FsEvent, FsEventKind, PathEntry } from "@xdev/bindings";
export type { CloseIntent, CloseRequest, HelpLink, MenuAction, QuitMode, ShellLabels, ShellSettings, UpdateChannel, UpdatePhase, UpdateDeferral, ReleaseBuild, ReleaseList };
export type { AiKeyStatus } from "@xdev/bindings";
export type { FileKind, GhAccount, GhLogin, RepoIcon } from "@xdev/bindings";
export type { CliAsk, CliOpenFile, CliOpenTab, TabReport };
export type { OrchestrationSettings, SkillStatus, WorkerLifetime, WorkerOpen, WorkerOpenOutcome, WorkerClose, ReadTab, WorkerChanged };
export type { CliStatus } from "@xdev/bindings";
export type { McpActivityView, McpHealth, McpToolView };
import type { Grant as LinkGrant, Message as OrchMessage, MissionSettings, MissionTab, MissionView, TabLink, TabWorker, Worker as OrchWorker } from "@xdev/bindings";
export type { LinkGrant, MissionSettings, MissionTab, MissionView, OrchMessage, OrchWorker, TabLink, TabWorker };
import type { Conversation, ConversationEntry, ConversationTool } from "@xdev/bindings";
export type { Conversation, ConversationEntry, ConversationTool };
export type { Breadcrumb, CrashDetail, CrashReport, DiagnosticsExport, RenderCrash, StartupReport, StartupStep } from "@xdev/bindings";
export type { RestoreMode } from "@xdev/bindings";
export type { Theme, EditorTheme, SidebarLook, StatusBarItems, TitlebarMode } from "@xdev/bindings";
export type { CustomScheme, OnNameTaken, SchemeColors, SchemeMode, SchemePreview } from "@xdev/bindings";
export type { ConfigKind, TermConfigDetected, TermConfigPreview } from "@xdev/bindings";
export type { SessionScope, SessionSort } from "@xdev/bindings";
import type { PromptTemplate } from "@xdev/bindings";
export type { PromptTemplate, TemplateMode } from "@xdev/bindings";
import type {
  PromptQueueChanged,
  PromptQueueDue,
  PromptQueueFacts,
  PromptQueueItem,
  PromptQueueNew,
  PromptQueueReport,
  PromptQueueWhenInput,
} from "@xdev/bindings";
export type {
  PromptQueueChanged,
  PromptQueueDue,
  PromptQueueFacts,
  PromptQueueItem,
  PromptQueueNew,
  PromptQueueQuotaFact,
  PromptQueueReport,
  PromptQueueStatus,
  PromptQueueTabFact,
  PromptQueueWhen,
  PromptQueueWhenInput,
} from "@xdev/bindings";
export type { AccountRouting, QuotaAlert, RoutePolicy } from "@xdev/bindings";
export type { FailedOver, FailReason, FailoverKind, WorkerFailover } from "@xdev/bindings";

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
  Cli,
  CustomShell,
  DefaultAgent,
  Permissions,
  Profile,
  ProfileView,
  ProfilesView,
  LaunchOverrides,
  LaunchVerdict,
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
  SoundName,
  NotificationPermission,
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
  Note,
  ContextUsage,
  StageState,
  ConflictOp,
  ConflictState,
  ConflictEntry,
  ConflictKind,
  ConflictResolution,
  ForkSync,
  ForkSyncBlock,
  ForkSyncStatus,
  LineCount,
  BaseRange,
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
  SidebarGroupBy,
  SidebarSort,
  ProjectOrder,
  CardProps,
  WorkItem,
  WorkItemKind,
  WorkStatus,
  Check,
  PrDraft,
  PrView,
  PrState,
  PrComment,
  PrComments,
  PrCommentKind,
  PrCommentDraft,
  PrReaction,
  Reaction,
  MergeMethod,
  MergeBlock,
  PrMergeInfo,
  RerunReport,
  Issue,
  IssueComment,
  IssueDetail,
  IssueQuery,
  IssueState,
  IssueDraft,
  IssueEdit,
  IssueEditReport,
  IssueCloseReason,
  IssueLabel,
  IssueEvent,
  IssueEventKind,
  IssuesPreset,
  PrSummary,
  MrSummary,
  MrState,
  PrBranch,
  PrFilter,
  PrQuery,
  ProjectSummary,
  CreateRequest,
  ShipView,
  RepoLog,
  LogCommit,
  CommitRef,
  RefKind,
  LogRef,
  CommitFiles,
  CommitFile,
  CommitFileStatus,
  PullPolicy,
  GitSettings,
  SourceControlGroupOrder,
  GitRecipes,
  Recipe,
  BranchPrefixMode,
  TerminalSettings,
  FontWeight,
  FontWeightBold,
  CursorStyle,
  TerminalGpu,
  TerminalBell,
  MacOptionAsAlt,
  TerminalLinkClick,
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
  TerminalSet,
  SetEntry,
  SetTarget,
  SetWorktree,
  SequenceStep,
  StepWait,
  StartupPreset,
  OpenInApp,
  OpenInSettings,
  OpenTarget,
  CloneProgress,
  NestedRepo,
  NestedScanResult,
  CreateProject,
  Created,
  NamePreview,
  ProjectKind,
  SparsePreset,
  BaseDrift,
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
export type AiKeyProvider = "anthropic" | "openai" | "gemini";
export const AI_KEY_PROVIDERS: readonly AiKeyProvider[] = ["anthropic", "openai", "gemini"];

export type ErrorCode =
  | "account_keychain"
  | "account_unavailable"
  | "account_link"
  | "account_state"
  | "account_code"
  | "account_expired"
  | "account_timeout"
  | "account_server"
  | "invalid_schedule"
  | "extra_args"
  | "not_found"
  | "outside_vault"
  | "no_vault"
  | "share_too_large"
  | "share_bad_image"
  | "share_clipboard"
  | "share_open"
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
  | "secret_store"
  | "empty_key"
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
  | "scan_failed"
  | "port_gone"
  | "port_not_owned"
  | "port_no_pid"
  | "port_own_process"
  | "port_scan_unavailable"
  | "port_changed"
  | "port_stop_unconfirmed"
  | "port_not_started_by_app"
  | "port_terminal_root"
  | "port_still_listening"
  | "stop_failed"
  | "open_failed"
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
  | "watch_limit"
  | "worktree_exists"
  | "branch_exists"
  | "bad_branch_prefix"
  | "bad_ref"
  | "bad_note"
  | "worktree_dirty"
  | "primary_worktree"
  | "empty_message"
  | "bad_profiles"
  | "trust_unsafe"
  | "invalid_profile"
  | "builtin_profile"
  | "profile_off"
  | "theme_invalid"
  | "theme_too_large"
  | "theme_name_taken"
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
  | "update_dirty"
  | "update_untracked"
  | "update_conflicted"
  | "update_conflicts"
  | "base_not_remote"
  | "pull_policy"
  | "no_web_remote"
  | "needs_force"
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
  | "pr_not_found"
  | "glab_missing"
  | "glab_auth"
  | "not_gitlab"
  | "glab_failed"
  | "mr_not_found"
  | "gh_scope"
  | "bad_draft"
  | "comment_too_large"
  | "pr_head_mismatch"
  | "pr_head_moved"
  | "empty_comment"
  | "nothing_to_rerun"
  | "merge_blocked"
  | "branch_in_use"
  | "bad_sparse"
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
  | "still_conflicted"
  | "conflict_gone"
  | "conflict_changed"
  | "not_a_conflict"
  | "bad_color"
  | "bad_icon"
  | "gh_account_missing"
  | "crash_store"
  | "diag_write"
  | "bad_routing"
  | "bad_env"
  | "config_shape"
  | "config_version"
  | "config_sections"
  | "config_too_large"
  | "orchestration";
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
  // `null` clears; an absent key leaves it. `color` is a preset name or "#rgb" / "#rrggbb"
  // (`bad_color`), an emoji icon is one grapheme (`bad_icon`), the issue command is capped at
  // 64 KiB (`too_large`).
  color?: string | null;
  icon?: RepoIcon | null;
  ghAccount?: GhAccount | null;
  localIssueCommand?: string;
  // The whole list; `[]` clears it. A blank or long name is `bad_name`, an empty or unusable folder
  // list `bad_sparse`, more than 20 presets `too_large`. A later preset replaces one of the same name.
  sparsePresets?: SparsePreset[];
  // The whole Environment list; `[]` clears it. A key that is not `[A-Za-z_][A-Za-z0-9_]*` or starts with
  // `XDEV_` is `bad_env`. A secret row's value is not sent here: see `repoEnvSecretSet`.
  env?: RepoEnvVar[];
};

// The `ptySpawn` profile id that runs the worktree's setup script in the default shell. Rejects
// with `setup_skipped` when the repo's setup policy is skip, `hook_none` when there is no setup and
// `hook_untrusted` when its shared part is not trusted.
export const SETUP_PROFILE = "xdev:setup";

export { QUICK_COMMAND_LIMITS } from "./quickCommands/limits";
export { TERMINAL_SET_LIMITS } from "./terminalSets/limits";

export interface Api {
  // The downloaded update waiting for a restart, if any; Rust checks and downloads on its own.
  updateStatus(): Promise<UpdateInfo | null>;
  onUpdateReady(cb: (update: UpdateInfo) => void): Promise<() => void>;
  // The version of this build.
  appVersion(): Promise<string>;
  // An OS notification; the text comes from here so it follows the UI language.
  notifyUpdate(title: string, body: string): Promise<void>;
  // A check the person asked for; `rc` also stores the release candidate channel. Resolves with where
  // the check ended, and `onUpdatePhase` follows every step of it and of the background checks.
  updateCheck(rc: boolean): Promise<UpdatePhase>;
  updatePhase(): Promise<UpdatePhase>;
  onUpdatePhase(cb: (phase: UpdatePhase) => void): Promise<() => void>;
  // The release the last check held back for the update delay, with the date it will be offered.
  updateDeferred(): Promise<UpdateDeferral | null>;
  // Recent releases of the app for the build picker; a failure is a value, not a rejection.
  updateReleases(): Promise<ReleaseList>;
  // Downloads the release `tag` through the update path, older versions included.
  updateInstallTag(tag: string): Promise<UpdatePhase>;
  // Settings → General, Window and Updates groups; the put returns what was stored.
  shellSettings(): Promise<ShellSettings>;
  shellSettingsPut(settings: ShellSettings): Promise<ShellSettings>;
  // Asked from the window close handler: `hide` means Rust hid the window to the tray, `close` means
  // go on to the quit guard. The notice text is what Rust shows the first time it hides.
  shellCloseRequested(noticeTitle: string, noticeBody: string): Promise<CloseRequest>;
  // Every quit goes through here; the window closes and the quit guard asks as for the close button.
  shellQuit(mode: QuitMode): Promise<void>;
  // The person said no in the quit guard.
  shellQuitCancelled(): Promise<void>;
  // The tray and native menu strings in the UI language.
  shellLabelsSet(labels: ShellLabels): Promise<void>;
  // A native menu or tray item the webview acts on.
  onMenuAction(cb: (action: MenuAction) => void): Promise<() => void>;
  helpOpen(link: HelpLink): Promise<void>;
  // Lights the tray dot when the window is hidden or minimized.
  trayAttention(): Promise<void>;
  windowReload(): Promise<void>;
  windowDevtoolsToggle(): Promise<void>;
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
  /** Which providers have an API key in the system keychain. A key is never returned. */
  aiKeys(): Promise<AiKeyStatus[]>;
  /** Trims and stores the key; `empty_key`, `too_large` or `secret_store` when it cannot. */
  aiKeySet(provider: AiKeyProvider, key: string): Promise<void>;
  /** True when a key was removed. */
  aiKeyRemove(provider: AiKeyProvider): Promise<boolean>;
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
  // A native dialog that takes one or more folders; empty when cancelled.
  pickFolders(): Promise<string[]>;
  // A native file dialog limited to `extensions` (no dot); null when cancelled.
  pickFile(extensions: string[]): Promise<string | null>;
  // Imported terminal schemes (`xdev-terminal-theme` files under the data dir), by name.
  terminalThemes(): Promise<CustomScheme[]>;
  // Reads and checks a theme file without saving it; rejects `theme_invalid` (detail: the field) or `theme_too_large`.
  terminalThemePreview(path: string): Promise<SchemePreview>;
  // Saves it; `theme_name_taken` when the name exists and `onTaken` is `fail`.
  terminalThemeImport(path: string, onTaken: OnNameTaken): Promise<CustomScheme>;
  // Moves an imported scheme to the trash.
  terminalThemeRemove(id: string): Promise<void>;
  // Which Ghostty / Kitty configs exist on this machine (the path of each, or null).
  termConfigDetect(): Promise<TermConfigDetected>;
  // The terminal settings a config sets; `path` null reads the detected file. Rejects `not_found`.
  termConfigRead(kind: ConfigKind, path: string | null): Promise<TermConfigPreview>;
  // Saves the config's colours as a custom scheme (replacing an earlier import of the same kind).
  termConfigSaveScheme(kind: ConfigKind, path: string | null): Promise<CustomScheme>;
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
  /** Saves the clipboard image as a PNG in the temp folder; null when the clipboard holds no image. Rejects `too_large`. */
  clipboardImageSave(): Promise<string | null>;
  /** macOS keyboard input source id; null elsewhere. */
  keyboardInputSource(): Promise<string | null>;
  /** Calls `listener` after any settings write, from this window or another. Returns the unsubscribe. */
  onSettingsChanged(listener: (e: SettingsChanged) => void): () => void;
  // Window view settings (zoom, 0.5..2); the put returns what was stored, clamped.
  uiSettingsGet(): Promise<UiSettings>;
  uiSettingsPut(s: UiSettings): Promise<UiSettings>;
  /** Stores Settings → Appearance → App icon (an unknown id stores "default"), puts it on the windows or the Dock, and returns the view settings as stored. */
  appIconSet(id: string): Promise<UiSettings>;
  // Keys. `keybindings.json` in the app config folder holds the shortcut overrides; Rust only moves
  // the text, `keys/keybindingsFile.ts` parses it. `text` is null when there is no file.
  keybindingsRead(): Promise<KeybindingsText>;
  // Replaces the whole file; rejects with `bad_arg` past 1 MiB.
  keybindingsWrite(text: string): Promise<void>;
  // Opens the folder, writing an empty version-1 file first when there is none.
  keybindingsReveal(): Promise<void>;
  // After our own write and when the file changes on disk.
  onKeybindingsChanged(fn: (text: string | null) => void): Promise<() => void>;
  // xDev ID (the person's xDev account). The token never leaves Rust.
  xdevIdState(): Promise<XdevIdState>;
  xdevIdSignIn(): Promise<XdevIdState>;
  xdevIdPaste(link: string): Promise<XdevIdState>;
  xdevIdCancel(): Promise<XdevIdState>;
  xdevIdSignOut(): Promise<XdevIdState>;
  xdevIdRefresh(): Promise<XdevIdState>;
  /** Opens the running attempt's link again; starts no new attempt. */
  xdevIdReopen(): Promise<void>;
  xdevIdManage(): Promise<void>;
  /** The server in use, where it came from, and the stored setting. */
  xdevIdServer(): Promise<XdevIdServer>;
  /** Saves `xdevId.server` (empty: the default). A different server signs out first. */
  xdevIdServerSet(value: string): Promise<XdevIdServer>;
  // `xdev-id://changed`: after sign-in, sign-out, expiry, refresh or a new avatar.
  onXdevIdChanged(cb: (s: XdevIdState) => void): Promise<() => void>;
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
  // The xdev command on PATH: whether a link (macOS, Linux) or shim (Windows) works, where it is and
  // whether its folder is on PATH. Install and repair reject with `cli_missing`, `cli_link_exists` or `cli_io`.
  cliStatus(): Promise<CliStatus>;
  cliInstall(): Promise<CliStatus>;
  cliRemove(): Promise<CliStatus>;
  cliRepair(): Promise<CliStatus>;
  // Shows the bundled binary in the file manager.
  cliReveal(): Promise<void>;
  // Settings → MCP. The switches of the app tools `xdev mcp` serves; a disabled tool is not listed.
  // Setting rejects with `mcp_unknown_tool` or `mcp_io`.
  mcpToolsGet(): Promise<McpToolView[]>;
  mcpToolSet(tool: string, enabled: boolean): Promise<McpToolView[]>;
  // The last 200 tool calls, newest first. Arguments are never kept.
  mcpActivity(): Promise<McpActivityView[]>;
  // Runs the bundled `xdev --version`.
  mcpHealth(): Promise<McpHealth>;
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
  ptySpawn(id: string, cwd: string, profileId: PtyProfile, account: string | null, cols: number, rows: number, onData: (bytes: Uint8Array) => void, resume?: string, fork?: boolean, prompt?: string, extraArgs?: string[], overrides?: LaunchOverrides): Promise<PtyInfo>;
  // Approves the launch `ptySpawn` was refused for; pass the same `resume` and `fork`, as they are part of the launch line.
  ptyApprove(profileId: PtyProfile, account: string | null, resume?: string, fork?: boolean, extraArgs?: string[], overrides?: LaunchOverrides): Promise<void>;
  // Agent profiles and the shells of the `+` menu; each write returns the whole view.
  profiles(): Promise<ProfilesView>;
  profilePut(p: Profile): Promise<ProfilesView>;
  profileRemove(id: string): Promise<ProfilesView>;
  profileReset(id: string): Promise<ProfilesView>;
  profilesDefaults(approvals: Approvals, defaultAgent: DefaultAgent, defaultShell: string | null): Promise<ProfilesView>;
  // Re-reads the shell PATH (macOS and Linux) and detects the agents again.
  agentsRefresh(): Promise<ProfilesView>;
  // Runs `--version` of the built-in agent `id` once and says what came of it. No network use by xDev.
  agentProbe(id: string): Promise<LaunchVerdict>;
  // Opens the built-in agent's docs or install page in the browser.
  agentDocsOpen(id: string): Promise<void>;
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
  // Where terminals run: `off` (in the app), `running` (the service), `fallback`, `old-version`, `newer-version`.
  ptydStatus(): Promise<PtydStatus>;
  // Every pty the service holds, attached or not.
  ptydSessions(): Promise<SessionInfo[]>;
  ptydEnd(id: string): Promise<void>;
  ptydEndAll(): Promise<void>;
  // Ends the service and every pty in it, then starts it again (Retry after a fallback).
  ptydRestart(): Promise<void>;
  // The saved output of the terminal `id` (the last 512 KB), or null when none is saved.
  ptySnapshot(id: string): Promise<Uint8Array | null>;
  // Deletes the saved output of `id`; a missing one is fine.
  ptySnapshotClear(id: string): Promise<void>;
  // Empties what the service holds of `id`, its ring and its saved output. The terminal keeps running.
  ptydClearScrollback(id: string): Promise<void>;
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
  // Removes the OS notifications still shown for one terminal (Linux; a no-op on macOS and Windows).
  // Never rejects.
  statusDismiss(ptyId: string): Promise<void>;
  // What macOS says about this app's notifications; "unknown" elsewhere and in an unbundled dev run.
  statusPermission(): Promise<NotificationPermission>;
  // Opens the macOS pane for this app's notifications; rejects with `unsupported` off macOS.
  statusOpenSettings(): Promise<void>;
  // Copies the person's own sound (wav, mp3 or ogg, at most 5 MiB) or clears it with null;
  // rejects with `bad_sound`. Picking one selects it (`soundName: "file"`); clearing goes back to "two-tone".
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
  // The repos under a folder, a few levels down (`.git` folders and files; symlinks, `node_modules` and
  // `target` are skipped). Nothing is added. `cancelled` when `cancelNestedScan` cut it short.
  scanNestedRepos(root: string): Promise<NestedScanResult>;
  // Stops the scan running now; it resolves with what it had found.
  cancelNestedScan(): Promise<void>;
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
  // `request` reuses a local branch (`existing`; `branch_in_use`, `bad_ref`) and limits the checkout to
  // cone folders (`sparse`; `bad_sparse`).
  worktreeCreate(repoId: string, name: string, from: string | null, request?: CreateRequest): Promise<WorktreeCreated>;
  // What `worktreeCreate` would name the branch and folder for a typed name, without making
  // anything; `suffixed` when the name was taken and got `-2`, `-3`, …
  worktreeNamePreview(repoId: string, name: string): Promise<NamePreview>;
  worktreePin(path: string, pinned: boolean): Promise<void>;
  // Rejects with `needs_approval` until `confirmed`, then with `worktree_dirty` for uncommitted
  // work until `force`, and with `primary_worktree` for the main checkout. A branch made here and
  // merged (or any with `force`) is deleted; otherwise it is kept and listed for review.
  // `deleteUnmerged` (default `force`) is what lets an unmerged branch go; `force` only skips the dirty check.
  worktreeRemove(path: string, force: boolean, confirmed: boolean, deleteUnmerged?: boolean): Promise<Removed>;
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
  /** A file at HEAD and on disk now; the base for change markers. */
  worktreeFileHead(path: string, file: string): Promise<WorktreeFileDiff>;
  // The new commit's id, or null when none of `files` had a change. Rejects with `empty_message`.
  worktreeCommit(path: string, files: string[], message: string): Promise<string | null>;
  // Line counts against the start ref (against HEAD for the primary checkout), untracked files included.
  worktreeStat(path: string): Promise<WorktreeStat>;
  // Shipping: where the branch stands against its upstream and base. Push, pull, sync and fetch
  // resolve with the new state. Push rejects with `no_remote`, `detached` or `push_rejected`; pull
  // with `no_upstream` or `pull_diverged`; a commit or amend with `hook_failed` (detail is the hook output).
  worktreeShip(path: string): Promise<ShipView>;
  worktreePush(path: string): Promise<ShipView>;
  // Also rejects with `pull_policy` (git cannot reconcile; see Settings → Git) and `update_conflicts`
  // (the pull stopped with conflicts and is left in progress). `worktreeSync` also rejects with `needs_force`.
  worktreePull(path: string): Promise<ShipView>;
  // Fast-forwards to the upstream. Rejects with `no_upstream`, `detached`, `pull_diverged`, `update_dirty`
  // and `update_untracked` (detail "fast-forward").
  worktreeFastForward(path: string): Promise<ShipView>;
  // Rebases onto the base. Rejects with `base_not_remote`, `update_dirty`, `update_untracked`
  // (detail "rebase"), `update_conflicted` and `update_conflicts` (the rebase is left in progress).
  worktreeRebaseFromBase(path: string): Promise<ShipView>;
  // The commit graph of `HEAD`; `limit` is clamped to 1..200.
  worktreeLog(path: string, limit: number, skip: number): Promise<RepoLog>;
  // Rejects with `bad_arg` for a bad id and `git` when it does not resolve.
  worktreeCommitFiles(path: string, id: string): Promise<CommitFiles>;
  worktreeCommitFile(path: string, id: string, file: string): Promise<WorktreeFileDiff>;
  // Reject with `no_web_remote` or `open_failed`. The URL is built in Rust.
  worktreeOpenCommit(path: string, id: string): Promise<void>;
  worktreeOpenFileOnHost(path: string, file: string, line: number | null, endLine: number | null): Promise<void>;
  worktreeSync(path: string): Promise<ShipView>;
  worktreeFetch(path: string): Promise<ShipView>;
  // `expected` is the remote commit the caller saw; without `confirmed` this rejects with `needs_approval`.
  worktreeForcePush(path: string, expected: string, confirmed: boolean): Promise<ShipView>;
  // Fast-forwards `origin`'s copy of `upstream`'s default branch; only when `hasForkUpstream`. The
  // local branch, index and work tree are not touched. A refusal is a `blocked` result, not a rejection.
  worktreeSyncFork(path: string): Promise<ForkSync>;
  // The new commit's id. Rejects with `nothing_to_amend`, or `amend_pushed` unless `confirmed`.
  worktreeAmend(path: string, files: string[], message: string, confirmed: boolean): Promise<string>;
  // Pull requests through the `gh` tool; null when the branch has none.
  worktreePr(path: string): Promise<PrView | null>;
  worktreePrCreate(path: string, draft: PrDraft): Promise<PrView>;
  worktreePrChecks(path: string, number: number): Promise<Check[]>;
  // Every review comment of the PR, oldest first, read with one GraphQL call.
  worktreePrComments(path: string, number: number): Promise<PrComments>;
  // A conversation comment, a reply (`replyTo`) or an inline comment (`path`, `line` and the `commit` the
  // lines were made on). Rejects with `empty_comment`, `comment_too_large` or, when `commit` is not the PR
  // head, `pr_head_mismatch`.
  worktreePrCommentPost(path: string, number: number, draft: PrCommentDraft): Promise<void>;
  // The head commit of the PR on GitHub.
  worktreePrHead(path: string, number: number): Promise<string>;
  worktreePrThreadResolve(path: string, threadId: string, resolved: boolean): Promise<void>;
  worktreePrReaction(path: string, subjectId: string, content: Reaction, on: boolean): Promise<void>;
  // Reruns the GitHub Actions runs behind the checks. Rejects with `nothing_to_rerun`.
  worktreePrChecksRerun(path: string, number: number, failedOnly: boolean): Promise<RerunReport>;
  worktreePrMergeInfo(path: string, number: number): Promise<PrMergeInfo>;
  // Rejects with `merge_blocked`; `detail` is the `MergeBlock`.
  worktreePrMerge(path: string, number: number, method: MergeMethod, headOid: string): Promise<void>;
  worktreePrOpen(path: string, checks: boolean): Promise<void>;
  // The logins `gh` holds, active one flagged; [] when none or `gh` is not signed in. Rejects with
  // `gh_missing`. A repo bound to a login that is gone rejects its `gh` calls with `gh_account_missing`.
  ghLogins(): Promise<GhLogin[]>;
  // GitHub issues of a repo through `gh`, read in its main checkout. Reject with the `gh_*` codes,
  // `not_github`, `issue_not_found`, or `issue_other_repo` (resolve only).
  issuesList(repoId: string, query: IssueQuery): Promise<Issue[]>;
  issueView(repoId: string, number: number): Promise<IssueDetail>;
  // `#12`, `12` or an issue URL of this repo; null when the text names no issue.
  issueResolve(repoId: string, text: string): Promise<Issue | null>;
  // Opens the issue in the browser through `gh`.
  issueOpen(repoId: string, number: number): Promise<void>;
  // Opens a new issue; rejects `bad_draft` for a blank or over-long title, or `gh_scope` when the
  // login lacks a scope.
  issueCreate(repoId: string, draft: IssueDraft): Promise<Issue>;
  // Changes an issue's state, labels, assignees, title or body; only what is set is sent, an empty
  // edit runs nothing. Every part is tried: `failed` names the parts that did not apply ("state",
  // "body", "fields") and `error` is the first error's text. Rejects `bad_draft` for a blank or
  // over-long title, an over-long body, or a label or login starting with `-`.
  issueEdit(repoId: string, number: number, edit: IssueEdit): Promise<IssueEditReport>;
  // Posts a comment. Rejects `empty_comment` or `comment_too_large`.
  issueComment(repoId: string, number: number, body: string): Promise<void>;
  // The repo's labels and the logins an issue can be assigned to.
  issueLabels(repoId: string): Promise<IssueLabel[]>;
  issueAssignable(repoId: string): Promise<string[]>;
  // Events of the known kinds, oldest first, at most 200.
  issueTimeline(repoId: string, number: number): Promise<IssueEvent[]>;
  // Pull requests and Projects of the repo through `gh`. `prGet` rejects `pr_not_found`.
  prsList(repoId: string, query: PrQuery): Promise<PrSummary[]>;
  prGet(repoId: string, number: number): Promise<PrSummary>;
  prOpen(repoId: string, number: number): Promise<void>;
  // The local branch to start a pull request on, fetched when needed; `branch_in_use` when a
  // worktree has it. A fork gives `pr-<n>`.
  prBranch(repoId: string, number: number): Promise<PrBranch>;
  // Deletes a branch `prBranch` fetched when the worktree on it was never made; a branch it did not
  // fetch, or one a worktree has, is left alone.
  prBranchDiscard(repoId: string, branch: string): Promise<void>;
  // Whether the repo's remote is a GitLab one, so merge requests apply instead of pull requests.
  gitlabDetect(repoId: string): Promise<boolean>;
  // Merge requests of a GitLab repo through `glab`; `state` null reads as open. `gitlabMrView`
  // rejects `mr_not_found`; `glab_missing`, `glab_auth` and `not_gitlab` say what is not set up.
  gitlabMrList(repoId: string, state: PrFilter | null): Promise<MrSummary[]>;
  gitlabMrView(repoId: string, iid: number): Promise<MrSummary>;
  // The local branch to start a merge request on, fetched when needed (a fork gives `mr-<iid>`);
  // `prBranchDiscard` takes back one it fetched.
  gitlabMrBranch(repoId: string, iid: number): Promise<PrBranch>;
  projectsList(repoId: string): Promise<ProjectSummary[]>;
  projectOpen(repoId: string, number: number): Promise<void>;
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
  // Settles one conflicted file the way `how` says. Rust reads the file again first: rejects with
  // `conflict_gone` when it is no longer unmerged, `conflict_changed` when its kind is not `expected`
  // and `not_a_conflict` when `how` is not offered for the kind (the detail is the path). Keep
  // deletion is gated like a discard (`confirmed`).
  worktreeConflictResolve(path: string, file: string, expected: ConflictKind, how: ConflictResolution, confirmed: boolean): Promise<void>;
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
  // The Stats page: filtered by agent and scope, and by `usage.scan` (an agent whose scan is off is not read).
  kitUsageReport(args: Omit<UsageReportArgs, "utcOffsetMinutes">): Promise<UsageReport>;
  // The share dialog: a PNG to the clipboard, and a post opened in the browser.
  usageShareCopyImage(png: Uint8Array): Promise<void>;
  usageSharePost(text: string): Promise<void>;
  // Whether each relative path exists under `root` (an agent home, repo or worktree).
  kitPathsExist(root: string, paths: string[]): Promise<boolean[]>;
  // Newest first, at most `limit` (and 1000).
  kitPromptHistory(limit: number): Promise<PromptEntry[]>;

  // Agent sessions
  // The agent sessions of every home, matched to the workspace; `refresh` reads the new log
  // bytes first. Rejects with `bad_arg` when `query.limit` is over 500.
  agentSessions(query: SessionQuery, refresh: boolean): Promise<SessionRow[]>;
  /** What the conversation text index holds. */
  sessionSearchStatus(): Promise<SessionSearchStatus>;
  /** Turns the search off, then deletes the index; returns the stored settings. */
  sessionSearchClear(): Promise<AgentsSettings>;
  /** The last `turns` (1-200, 6 when absent) user and assistant texts of a session, oldest first, each cut to `chars` (1-8000, 1200 when absent). Rejects `not_found`, `bad_path`. */
  agentSessionTail(key: string, turns?: number, chars?: number): Promise<SessionTurn[]>;
  /** The path of a session's log file. Rejects `not_found`, `bad_path`. */
  agentSessionLogPath(key: string): Promise<string>;
  /** Opens a session's log file with the OS. */
  agentSessionOpenLog(key: string): Promise<void>;
  /** Shows a session's log file in the file manager. */
  agentSessionRevealLog(key: string): Promise<void>;
  /** Deletes a session's log file when it is inside the agent's session store, then reads the logs again. Rejects `not_found`, `bad_path`, `io`. */
  agentSessionDelete(key: string): Promise<void>;
  /** The logs the last scan could not read or that were too large; at most 20 paths. */
  agentSessionsSkipped(): Promise<SkippedLogs>;
  /** Tokens used and the model's window for an agent session (its CLI session id or `<home id>:<id>` key), read from the end of its log; `null` when unknown. */
  agentContextUsage(session: string): Promise<ContextUsage | null>;
  // Sticky notes, one Markdown note per tab (64 KB at most; a longer one rejects `bad_note`).
  /** Every note, newest first. */
  notesList(): Promise<Note[]>;
  notesGet(tab: string): Promise<Note | null>;
  /** Saves the note (the time is set by the store); a blank body removes it and returns `null`. */
  notesPut(note: Note): Promise<Note | null>;
  notesDelete(tab: string): Promise<void>;

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

  // Terminal sets and startup presets (settings.json `terminalSets`, `startupPresets`). Every change
  // fires `settings://changed` with `terminalSets`. Upserts reject with `bad_arg` and the field in
  // `detail`: `name`, `entries`, `profile`, `command`, `wait`, `steps`, `worktree` or `list` (at
  // `TERMINAL_SET_LIMITS.list`). An empty `id` gets a new one at the end; a known id is replaced in place.
  terminalSetsList(): Promise<TerminalSet[]>;
  terminalSetUpsert(item: TerminalSet): Promise<TerminalSet>;
  // An unknown id is a no-op.
  terminalSetDelete(id: string): Promise<void>;
  startupPresetsList(): Promise<StartupPreset[]>;
  startupPresetUpsert(item: StartupPreset): Promise<StartupPreset>;
  startupPresetDelete(id: string): Promise<void>;
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
  // Terminal links. Each candidate's worktree-relative path when it is an existing file inside
  // `worktree`; null otherwise. At most 64 per call (`bad_arg`). A relative path is read against
  // `cwd` (the shell's folder, when known and inside the worktree) first, then the worktree root.
  fileLinksResolve(worktree: string, paths: string[], cwd?: string): Promise<(string | null)[]>;
  // The raw bytes of an image, audio or video file within its size cap; rejects with `too_large`, `bad_name`, `not_found`.
  fileBytes(worktree: string, rel: string): Promise<Uint8Array>;
  // Opens the file with the OS default app; `denied` for a type outside the allowlist (media and txt md pdf png jpg jpeg gif webp svg html htm csv json log).
  fileOpenDefault(worktree: string, rel: string): Promise<void>;
  // http(s) only; `bad_arg` otherwise.
  openUrl(url: string): Promise<void>;
  // Hosted URL of the file at `line` (to `endLine`); `no_web_remote` when there is none.
  fileRemoteUrl(worktree: string, rel: string, line: number, endLine: number | null): Promise<string>;
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
  // Watches the worktree's files: `onEvent` gets one batch (worktree-relative `/` paths) after
  // the first change and at most every 100 ms. Ignores `.git`, `node_modules`, `dist`, `build`,
  // `.next`, `.cache`, `target`, `.venv` and `__pycache__` at any depth. `overflow` means
  // "re-read everything" (too many events, or the watcher failed and stopped). Subscribers of
  // one worktree share one watcher; the same `id` again replaces its subscription.
  filesWatch(worktree: string, id: string, onEvent: (e: FsChanged) => void): Promise<void>;
  // Ends the subscription `id`; nothing when it is not there.
  filesUnwatch(id: string): Promise<void>;
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
  // The PATH new terminals and agents get, in order: the owner's entries over the system ones.
  pathEffective(): Promise<PathEntry[]>;
  // Settings → Orchestration; the put returns what was stored, with the depth clamped to 1..9.
  orchestrationSettings(): Promise<OrchestrationSettings>;
  orchestrationSettingsPut(v: OrchestrationSettings): Promise<OrchestrationSettings>;
  // Keep computer awake: the stored mode, whether an OS request is held, whether this machine can hold one.
  keepAwake(): Promise<AwakeView>;
  keepAwakeSet(mode: KeepAwake): Promise<AwakeView>;
  // Reports whether any agent tab is working; the backend decides in `agent` mode.
  keepAwakeAgents(working: boolean): Promise<AwakeView>;
  onKeepAwakeChanged(cb: (v: AwakeView) => void): Promise<() => void>;
  // Counters kept on this computer: agents started, time agents worked, PRs created.
  appStats(): Promise<AppStatsView>;
  // A tab entered (true) or left (false) the working status.
  appStatsBusy(tabId: string, working: boolean): Promise<void>;
  // The last `limitLines` lines a tab printed, ANSI stripped; empty for an unknown tab or one without output.
  termTailRead(tabId: string, limitLines: number): Promise<string>;
  // Opens a native save dialog (in Rust) and writes the text as a `.txt` file; resolves with the path, or null
  // when cancelled. Rejects `too_large` over 4 MB.
  transcriptSave(defaultName: string, text: string): Promise<string | null>;
  // CPU and memory per running tab (its terminal process and everything below it) and of the app, biggest
  // memory first; null when the process table cannot be read.
  resourcesSnapshot(): Promise<ResourceSnapshot | null>;
  // Ports: one scan of the local listeners for these worktrees (`force` skips the back-off wait), stopping
  // the process behind a port id, opening its URL in the OS browser, and a terminal printing a new URL.
  portsScan(worktrees: string[], force: boolean): Promise<PortScan>;
  // A stop needs `confirmed`; a port no xDev terminal started also needs `outsideTerminal`, the second
  // confirmation, and so does a listener that is a terminal's own process. Rejects with
  // `port_stop_unconfirmed` / `port_not_started_by_app` / `port_terminal_root` otherwise.
  portsStop(worktrees: string[], id: string, consent: PortStopConsent): Promise<PortScan>;
  portsOpen(id: string): Promise<void>;
  onPortsAdvertised(cb: (worktree: string) => void): Promise<() => void>;
  // Saved SSH hosts. A save with an empty id adds one; the alias is trimmed and unique; a saved host is a
  // manual one. Rejects with `bad_arg` (detail: alias, host_name, port, duplicate_alias, proxy_jump,
  // local_forward, extra_option) or `not_found`.
  sshHostsList(): Promise<SshHost[]>;
  sshHostSave(host: SshHost): Promise<SshHost>;
  sshHostRemove(id: string): Promise<void>;
  // Returns how many were removed.
  sshHostsRemoveMany(ids: string[]): Promise<number>;
  // Re-reads ~/.ssh/config: adds new aliases and updates the synced ones; manual hosts are never touched.
  sshConfigSync(): Promise<SshSyncReport>;
  // One batch-mode ssh to the host (no prompts), killed after its connect timeout + 2 s. Rejects with
  // `not_found` for an unknown id.
  sshHostTest(id: string): Promise<SshTestOutcome>;
  // Kept connections: a background `ssh -N` per host that holds its local forwards. Connect is a no-op
  // while one is connecting or connected; the state then moves by `onSshState`.
  sshConnect(id: string): Promise<SshConnectionView>;
  sshDisconnect(id: string): Promise<void>;
  sshConnectionsList(): Promise<SshConnectionView[]>;
  onSshState(cb: (view: SshConnectionView) => void): Promise<() => void>;
  // A connection's ssh asks for a password, passphrase or confirmation. Answer with `sshAuthReply`
  // (null cancels); `onSshAuthClosed` fires when the prompt ends either way.
  onSshAuthPrompt(cb: (prompt: SshAuthPrompt) => void): Promise<() => void>;
  onSshAuthClosed(cb: (requestId: string) => void): Promise<() => void>;
  // Rejects with `not_found` when the prompt has already ended.
  sshAuthReply(requestId: string, answer: string | null): Promise<void>;
  usageSettings(): Promise<UsageSettings>;
  usageSettingsPut(v: UsageSettings): Promise<UsageSettings>;
  // Settings → Automations; the put returns what was stored.
  automationsSettings(): Promise<AutomationsSettings>;
  automationsSettingsPut(v: AutomationsSettings): Promise<AutomationsSettings>;
  // Settings → Advanced; the put returns what was stored and refuses an invalid proxy or mirror.
  networkSettings(): Promise<NetworkSettings>;
  networkSettingsPut(v: NetworkSettings): Promise<NetworkSettings>;
  // The machine name in effect: the chosen one, else the OS host name.
  machineName(): Promise<string>;

  // Layout
  // The tabs and splits saved for the next start (`<data_dir>/layout.json`); null when none is saved
  // or the file does not parse (it is kept as `layout.json.bad`).
  layoutLoad(): Promise<LayoutSnapshot | null>;
  // Replaces the saved layout. Rejects with `bad_arg` when `version` is not `LAYOUT_VERSION` and
  // `too_large` past 1 MiB.
  layoutSave(snapshot: LayoutSnapshot): Promise<void>;
  // The app CLI (`xdev status | worktree | terminal`). The UI owns the tab states: it reports every
  // tab (and the worktree in front) when they change, and `xdev terminal wait` reads them.
  cliTabsReport(tabs: TabReport[], selected: string | null): Promise<void>;
  // The person's answer to a `cli://ask`; an unknown or late request is ignored.
  cliApprove(request: number, allow: boolean): Promise<void>;
  // The CLI changed the registry (`workspace://changed`): the sidebar loads again.
  onWorkspaceChanged(cb: () => void): Promise<() => void>;
  // `xdev worktree create --agent/--prompt` (`cli://open-tab`): open `profile` (empty: the default
  // agent) in `worktree` without focusing it, and type `prompt` once it is ready.
  onCliOpenTab(cb: (e: CliOpenTab) => void): Promise<() => void>;
  // A CLI write that needs the person (`cli://ask`); answer with `cliApprove`.
  onCliAsk(cb: (e: CliAsk) => void): Promise<() => void>;
  // `xdev file open` (`cli://open-file`): a file of a known worktree to show; the window is in front already.
  onCliOpenFile(cb: (e: CliOpenFile) => void): Promise<() => void>;
  // Orchestration. The skill card, the strip over a worker's terminal, and the answers the UI owes the backend.
  orchestrationSkillStatus(): Promise<SkillStatus>;
  orchestrationSkillInstall(force?: boolean): Promise<SkillStatus>;
  orchestrationSkillUninstall(force?: boolean): Promise<SkillStatus>;
  orchestrationWorkerLifetime(tab: string): Promise<WorkerLifetime | null>;
  orchestrationWorkerKeepOpen(tab: string, keep: boolean): Promise<WorkerLifetime>;
  orchestrationWorkerOpened(dispatch: string, outcome: WorkerOpenOutcome): Promise<void>;
  orchestrationReadAnswer(request: number, text: string): Promise<void>;
  onOrchestrationOpenWorker(cb: (e: WorkerOpen) => void): Promise<() => void>;
  onOrchestrationCloseWorker(cb: (e: WorkerClose) => void): Promise<() => void>;
  onOrchestrationReadTab(cb: (e: ReadTab) => void): Promise<() => void>;
  onOrchestrationWorkerChanged(cb: (e: WorkerChanged) => void): Promise<() => void>;

  // Automations: scheduled agent runs. Writes reject with `not_found`, `bad_arg`, `invalid_schedule`
  // or `extra_args` (`detail` has the `ExtraArgsError`).
  automationsList(): Promise<AutomationsView>;
  // The runs of one automation, newest first.
  automationRuns(automationId: string): Promise<AutomationRun[]>;
  // Every run that began in the range (default 7d), newest first, with the tokens and cost of its agent session when one is matched, and the totals.
  automationRunsSummary(range?: RunsRange): Promise<RunsSummary>;
  automationCreate(input: AutomationInput): Promise<Automation>;
  automationUpdate(id: string, input: AutomationInput): Promise<Automation>;
  automationSetEnabled(id: string, enabled: boolean): Promise<Automation>;
  // Deletes the automation and its runs; worktrees its runs made stay.
  automationDelete(id: string): Promise<void>;
  // A manual run, also for a paused automation.
  automationRunNow(id: string): Promise<AutomationRun>;
  automationDescribe(expr: string, timezone: string): Promise<Describe>;
  // The error copy key of a schedule that cannot be saved, or null when it can.
  automationValidateSchedule(expr: string, timezone: string): Promise<ScheduleProblem | null>;
  // The next `count` (at most 5) occurrences from `dtstart`, epoch ms, for the editor preview.
  automationNextRuns(expr: string, timezone: string, dtstart: number, count: number): Promise<number[]>;
  // The UI can open tabs: tells the backend a dispatch may be sent. One tick follows.
  automationUiReady(): Promise<void>;
  // How a dispatch ended in the UI; one result per run.
  automationDispatchResult(result: DispatchResult): Promise<void>;
  // The end of a run, read from the tab's status.
  automationRunFinish(finish: RunFinish): Promise<void>;
  // `automation://dispatch`: open a tab for one run and type its prompt.
  onAutomationDispatch(cb: (e: AutomationDispatch) => void): Promise<() => void>;
  // `automations://changed`: an automation or run changed; load the list again.
  onAutomationsChanged(cb: (e: AutomationsChanged) => void): Promise<() => void>;

  // Crash reports stay on this machine (`<local_dir>/crash-reports.json`); nothing is sent.
  // A boundary caught a render error: keeps a report and returns it, so it can be shown at once.
  crashRecordRender(crash: RenderCrash): Promise<CrashReport | null>;
  // Adds a breadcrumb (the last 30 go into the next report). Never rejects.
  crashBreadcrumb(name: string, data: CrashDetail[]): Promise<void>;
  // The newest pending report, once: it is marked dismissed as it is taken.
  crashTakePending(): Promise<CrashReport | null>;
  // The newest report of any status.
  crashLatest(): Promise<CrashReport | null>;
  // Dismisses a report, and pending ones of the same storm within 5 s.
  crashDismiss(id: string): Promise<void>;
  // The setup steps of this start; the UI adds its own with `startupMark`.
  startupReport(): Promise<StartupReport>;
  startupMark(step: StartupStep): Promise<void>;
  // Restarts the app.
  appRelaunch(): Promise<void>;
  // Opens a native save dialog (in Rust, so the path never comes from the webview), writes the redacted
  // diagnostics file there and returns where it went; null when cancelled. Rejects with `diag_write`.
  diagnosticsExport(defaultName: string): Promise<DiagnosticsExport | null>;
  // Shows an exported `.ndjson` file in the file manager.
  diagnosticsRevealExport(path: string): Promise<void>;
  // Opens the folder of the app log.
  diagnosticsRevealLogs(): Promise<void>;
  // The composer's unsent text of a terminal tab; null when it has none.
  composerDraftGet(tabId: string): Promise<string | null>;
  // Keeps the draft of a tab; an empty text clears it. Rejects with `too_large` over 64 KB.
  composerDraftPut(tabId: string, text: string): Promise<void>;
  // Forgets the draft of a tab; true when there was one.
  composerDraftClear(tabId: string): Promise<boolean>;
  // Every prompt template, by name.
  promptTemplatesList(): Promise<PromptTemplate[]>;
  // Adds a template or replaces the one with its id, and returns the list. Rejects with `too_large` past 200.
  promptTemplatesPut(template: PromptTemplate): Promise<PromptTemplate[]>;
  // Removes a template and returns the list.
  promptTemplatesDelete(id: string): Promise<PromptTemplate[]>;
  // Every queued prompt of every tab, in the order they go.
  promptQueueList(): Promise<PromptQueueItem[]>;
  // Queues a prompt at the end of its tab's queue. Rejects with `too_large` past 50 per tab or 16 KB.
  promptQueueAdd(item: PromptQueueNew): Promise<PromptQueueItem>;
  // Changes the text and the time of an item that is not being sent.
  promptQueueUpdate(id: string, text: string, when: PromptQueueWhenInput): Promise<PromptQueueItem>;
  // Removes an item that is not being sent; also Skip for one that failed.
  promptQueueDelete(id: string): Promise<void>;
  // Moves an item one place up (below 0) or down in its tab's queue.
  promptQueueReorder(id: string, delta: number): Promise<void>;
  // Makes an item due now; also Retry for one that failed.
  promptQueueSendNow(id: string): Promise<PromptQueueItem>;
  // How a send of a due item ended.
  promptQueueReport(id: string, report: PromptQueueReport): Promise<void>;
  // The live tabs, whether each agent is idle, and the 5-hour quota windows; send on change and every 30 s.
  promptQueueFacts(facts: PromptQueueFacts): Promise<void>;
  // `prompt-queue://due`: items to send now (already marked as being sent).
  onPromptQueueDue(cb: (e: PromptQueueDue) => void): Promise<() => void>;
  // `prompt-queue://changed`: the queue changed; read it again.
  onPromptQueueChanged(cb: (e: PromptQueueChanged) => void): Promise<() => void>;
  // How each provider's new agents pick their account, Claude then Codex.
  accountsRouting(): Promise<AccountRouting[]>;
  // Stores one provider's routing; rejects with `bad_routing` (a pool or priority name that is not
  // one of its accounts, a percent outside 1..=100, more than 4 thresholds).
  accountRoutingSet(routing: AccountRouting): Promise<void>;
  // Makes the account the provider's routing picks, other than `avoid` (null: the active one), the
  // default for new tabs. Resolves with its name, or null when there is no other account to use.
  accountUseNext(provider: Provider, avoid: string | null): Promise<string | null>;
  // `accounts://quota-alert`: an account crossed one of its provider's thresholds, once per window.
  onQuotaAlert(cb: (alert: QuotaAlert) => void): Promise<() => void>;
  // Settings → Advanced, Export settings. Opens a native save dialog (in Rust), writes the chosen sections
  // as `{ xdev: 1, exported, sections }` without secrets and returns where it went; null when cancelled.
  // Rejects `config_sections` when none of `sections` can be exported.
  configExport(sections: string[]): Promise<ConfigExported | null>;
  // Reads the file at `path` and says, section by section, what importing it would change. Changes nothing.
  // Rejects `config_shape`, `config_version` (detail: the version found) or `config_too_large`.
  configImportPreview(path: string): Promise<ImportPreview>;
  // Applies the chosen sections of that file through the settings write path and returns the ones applied.
  configImportApply(path: string, sections: string[]): Promise<ImportApplied>;
  // Per-project environment. The keys of the repo's secret rows that have a value in the keychain; never a value.
  repoEnvSecrets(repoId: string): Promise<string[]>;
  // Keeps a secret row's value in the keychain. Save the row with `repoUpdate` first (`bad_env` otherwise).
  repoEnvSecretSet(repoId: string, key: string, value: string): Promise<void>;
  // Forgets the stored value of a key.
  repoEnvSecretClear(repoId: string, key: string): Promise<void>;
  // The effective project env, secrets masked; `overrides` marks a name the process env also has.
  repoEnvPreview(repoId: string): Promise<EnvPreviewRow[]>;
  // Mission Control: the reported tabs with their worker, last nudge and links. Links to tabs that left are pruned.
  orchestrationMission(): Promise<MissionView>;
  // Stores the stuck threshold (1-1440 minutes) and the nudge text; returns what was stored.
  orchestrationMissionSettingsPut(settings: MissionSettings): Promise<MissionSettings>;
  // Links `from -> to` (from may read to) with both grants off; an existing link is kept.
  orchestrationLinkPut(from: string, to: string): Promise<TabLink>;
  orchestrationLinkGrant(from: string, to: string, grant: LinkGrant, on: boolean): Promise<TabLink>;
  // Points the link at `target`; its grants start off again.
  orchestrationLinkRetarget(from: string, to: string, target: string): Promise<TabLink>;
  orchestrationLinkRemove(from: string, to: string): Promise<boolean>;
  // Types the nudge text into the agent in `tab` and keeps it as mail.
  orchestrationNudge(tab: string): Promise<OrchMessage>;
  // Types `text` into the agent in `to` under a header naming `from`. Rejects for a shell or a closed tab.
  orchestrationHandoff(from: string, to: string, text: string): Promise<OrchMessage>;
  // Stops the worker in `tab` along the worker-stop path; rejects with `not_worker` for a tab without one.
  orchestrationTabStop(tab: string): Promise<OrchWorker>;
  // Where a worker came from when it took over a failed or stuck one; null for a first worker.
  orchestrationWorkerFailover(tab: string): Promise<FailedOver | null>;
  // `orchestration://failover`: a worker failed over, restarted, or was marked failed; once each.
  onOrchestrationFailover(cb: (e: WorkerFailover) => void): Promise<() => void>;
  /** One page of an agent session's conversation (its CLI session id or `<home id>:<id>` key): messages, tool steps and markers. `from` absent gives the last page; `limit` is 200 when absent, at most 1000. Rejects `not_found`, `bad_path`, `io`. */
  agentConversation(key: string, from?: number, limit?: number): Promise<Conversation>;
}

function seen({ path, hash }: Seen): Seen {
  return { path, hash };
}

export const ERROR_CODES: readonly ErrorCode[] = [
  "secret_store",
  "empty_key",
  "account_keychain",
  "account_unavailable",
  "account_link",
  "account_state",
  "account_code",
  "account_expired",
  "account_timeout",
  "account_server",
  "invalid_schedule",
  "extra_args",
  "not_found",
  "outside_vault",
  "no_vault",
  "share_too_large",
  "share_bad_image",
  "share_clipboard",
  "share_open",
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
  "scan_failed",
  "port_gone",
  "port_not_owned",
  "port_no_pid",
  "port_own_process",
  "port_scan_unavailable",
  "port_changed",
  "port_stop_unconfirmed",
  "port_not_started_by_app",
  "port_terminal_root",
  "port_still_listening",
  "stop_failed",
  "open_failed",
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
  "watch_limit",
  "worktree_exists",
  "branch_exists",
  "bad_branch_prefix",
  "bad_ref",
  "bad_note",
  "worktree_dirty",
  "primary_worktree",
  "empty_message",
  "bad_profiles",
  "trust_unsafe",
  "invalid_profile",
  "builtin_profile",
  "profile_off",
  "theme_invalid",
  "theme_too_large",
  "theme_name_taken",
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
  "update_dirty",
  "update_untracked",
  "update_conflicted",
  "update_conflicts",
  "base_not_remote",
  "pull_policy",
  "no_web_remote",
  "needs_force",
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
  "pr_not_found",
  "glab_missing",
  "glab_auth",
  "not_gitlab",
  "glab_failed",
  "mr_not_found",
  "gh_scope",
  "bad_draft",
  "comment_too_large",
  "pr_head_mismatch",
  "pr_head_moved",
  "empty_comment",
  "nothing_to_rerun",
  "merge_blocked",
  "branch_in_use",
  "bad_sparse",
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
  "conflict_gone",
  "conflict_changed",
  "not_a_conflict",
  "bad_color",
  "bad_icon",
  "gh_account_missing",
  "crash_store",
  "diag_write",
  "bad_routing",
  "bad_env",
  "config_shape",
  "config_version",
  "config_sections",
  "config_too_large",
  "orchestration",
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
  appVersion: () => getVersion(),
  notifyUpdate: (title, body) => call("update_notify", { title, body }),
  updateCheck: (rc) => call("update_check", { rc }),
  updatePhase: () => call("update_phase"),
  onUpdatePhase: (cb) => listen<UpdatePhase>("update-phase", (e) => cb(e.payload)),
  updateDeferred: () => call("update_deferred"),
  updateReleases: () => call("update_releases"),
  updateInstallTag: (tag) => call("update_install_tag", { tag }),
  shellSettings: () => call("shell_settings_get"),
  shellSettingsPut: (settings) => call("shell_settings_put", { settings }),
  shellCloseRequested: (noticeTitle, noticeBody) => call("shell_close_requested", { noticeTitle, noticeBody }),
  shellQuit: (mode) => call("shell_quit", { mode }),
  shellQuitCancelled: () => call("shell_quit_cancelled"),
  shellLabelsSet: (labels) => call("shell_labels_set", { labels }),
  onMenuAction: (cb) => listen<{ action: MenuAction }>("shell://menu", (e) => cb(e.payload.action)),
  helpOpen: (link) => call("help_open", { link }),
  trayAttention: () => call("tray_attention"),
  windowReload: () => call("window_reload"),
  windowDevtoolsToggle: () => call("window_devtools_toggle"),
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
  aiKeys: () => call("ai_keys_list"),
  aiKeySet: (provider, key) => call("ai_key_set", { provider, key }),
  aiKeyRemove: (provider) => call("ai_key_remove", { provider }),
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
  async pickFolders() {
    const picked = await open({ directory: true, multiple: true });
    return Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
  },
  async pickFile(extensions) {
    const picked = await open({ multiple: false, directory: false, filters: [{ name: "", extensions }] });
    return typeof picked === "string" ? picked : null;
  },
  terminalThemes: () => call("terminal_themes_list"),
  terminalThemePreview: (path) => call("terminal_theme_preview", { path }),
  terminalThemeImport: (path, onTaken) => call("terminal_theme_import", { path, onTaken }),
  terminalThemeRemove: (id) => call("terminal_theme_remove", { id }),
  termConfigDetect: () => call("term_config_detect"),
  termConfigRead: (kind, path) => call("term_config_read", { kind, path }),
  termConfigSaveScheme: (kind, path) => call("term_config_save_scheme", { kind, path }),
  openVault: (path) => call("open_vault", { path }),
  lastVault: () => call("last_vault"),
  vaultSetup: () => call("vault_setup"),
  dismissVaultPrompt: () => call("dismiss_vault_prompt"),
  gitSettings: () => call("git_settings"),
  setGitSettings: (git) => call("set_git_settings", { git }),
  terminalSettings: () => call("terminal_settings_get"),
  terminalSettingsPut: (settings) => call("terminal_settings_put", { settings }),
  clipboardImageSave: () => call("clipboard_image_save"),
  keyboardInputSource: () => call("keyboard_input_source"),
  onSettingsChanged: (listener) => {
    const unlisten = listen<SettingsChanged>("settings://changed", (e) => listener(e.payload));
    return () => void unlisten.then((stop) => stop());
  },
  uiSettingsGet: () => call("ui_settings_get"),
  uiSettingsPut: (settings) => call("ui_settings_put", { settings }),
  appIconSet: (id) => call("app_icon_set", { id }),
  keybindingsRead: () => call("keybindings_read"),
  keybindingsWrite: (text) => call("keybindings_write", { text }),
  keybindingsReveal: () => call("keybindings_reveal"),
  onKeybindingsChanged: (fn) => listen<KeybindingsChanged>("keybindings://changed", (e) => fn(e.payload.text)),
  xdevIdState: () => call("xdev_id_state"),
  xdevIdSignIn: () => call("xdev_id_sign_in"),
  xdevIdPaste: (link) => call("xdev_id_paste", { link }),
  xdevIdCancel: () => call("xdev_id_cancel"),
  xdevIdSignOut: () => call("xdev_id_sign_out"),
  xdevIdRefresh: () => call("xdev_id_refresh"),
  xdevIdReopen: () => call("xdev_id_reopen"),
  xdevIdManage: () => call("xdev_id_manage"),
  xdevIdServer: () => call("xdev_id_server"),
  xdevIdServerSet: (value) => call("xdev_id_server_set", { value }),
  onXdevIdChanged: (cb) => listen<XdevIdState>("xdev-id://changed", (e) => cb(e.payload)),
  keySettingsGet: () => call("key_settings_get"),
  keySettingsPut: (settings) => call("key_settings_put", { settings }),
  gitUserName: () => call("git_user_name"),
  createVault: (path, file, content) => call("create_vault", { path, file, content }),
  listDocs: () => call("list_docs"),
  readDoc: (path) => call("read_doc", { path }),
  writeDoc: (path, content) => call("write_doc", { path, content }),
  createDoc: (path, content) => call("create_doc", { path, content }),
  cliPath: () => call("cli_path"),
  cliStatus: () => call("cli_status"),
  cliInstall: () => call("cli_install"),
  cliRemove: () => call("cli_remove"),
  cliRepair: () => call("cli_repair"),
  cliReveal: () => call("cli_reveal"),
  mcpToolsGet: () => call("mcp_tools_get"),
  mcpToolSet: (tool, enabled) => call("mcp_tool_set", { tool, enabled }),
  mcpActivity: () => call("mcp_activity"),
  mcpHealth: () => call("mcp_health"),
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
  ptySpawn(id, cwd, profileId, account, cols, rows, onData, resume, fork, prompt, extraArgs, overrides) {
    // Rust sends raw bytes, which arrive as an ArrayBuffer.
    const out = new Channel<ArrayBuffer | number[]>();
    out.onmessage = (msg) => onData(toBytes(msg));
    return call("pty_spawn", { id, cwd, profileId, account, cols, rows, out, resume: resume ?? null, fork: fork ?? null, prompt: prompt ?? null, extraArgs: extraArgs ?? null, ...(overrides ? { overrides } : {}) });
  },
  ptyApprove: (profileId, account, resume, fork, extraArgs, overrides) => call("pty_approve", { profileId, account, resume: resume ?? null, fork: fork ?? null, extraArgs: extraArgs ?? null, ...(overrides ? { overrides } : {}) }),
  profiles: () => call("profiles_list"),
  profilePut: (profile) => call("profile_put", { profile }),
  profileRemove: (id) => call("profile_remove", { id }),
  profileReset: (id) => call("profile_reset", { id }),
  profilesDefaults: (approvals, defaultAgent, defaultShell) => call("profiles_defaults", { approvals, defaultAgent, defaultShell }),
  agentsRefresh: () => call("agents_refresh"),
  agentProbe: (id) => call("agent_probe", { id }),
  agentDocsOpen: (id) => call("agent_docs_open", { id }),
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
  ptySnapshot: async (id) => {
    const got = await call<ArrayBuffer | number[] | null>("pty_snapshot", { id });
    return got === null ? null : toBytes(got);
  },
  ptySnapshotClear: (id) => call("pty_snapshot_clear", { id }),
  ptydClearScrollback: (id) => call("ptyd_clear_scrollback", { id }),
  ptydQuitChoice: (end) => call("ptyd_quit_choice", { end }),
  onPtydStatus: (cb) => listen<PtydStatus>("ptyd://status", (e) => cb(e.payload)),
  onPtyHook: (cb) => listen<PtyHook>("pty://hook", (e) => cb(e.payload)),
  statusSettings: () => call("status_settings_get"),
  statusSettingsPut: (settings) => call("status_settings_put", { settings }),
  statusNotify: (title, body, ptyId) => call("status_notify", { title, body, ptyId }),
  onStatusNotificationClick: (cb) => listen<{ ptyId: string }>("status://notification-click", (e) => cb(e.payload.ptyId)),
  statusBadge: (count) => call("status_badge", { count }),
  statusDismiss: (ptyId) => call<void>("status_dismiss", { ptyId }).catch(() => {}),
  statusPermission: () => call("status_permission"),
  statusOpenSettings: () => call("status_open_settings"),
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
  repoUpdate: (id, patch) => call("repo_update", { id, patch }),
  repoHooks: (path) => call("repo_hooks", { path }),
  repoHookTrust: (path, kind, hash) => call("repo_hook_trust", { path, kind, hash }),
  worktreeArchiveRun: (path) => call("worktree_archive_run", { path }),
  worktreeAdopt: (path) => call("worktree_adopt", { path }),
  scanNestedRepos: (root) => call("scan_nested_repos", { root }),
  cancelNestedScan: () => call("cancel_nested_scan"),
  vaultList: () => call("vault_list"),
  vaultAdd: (path) => call("vault_add", { path }),
  vaultForget: (id) => call("vault_forget", { id }),
  vaultCreateDocs: (repoId, file, content) => call("vault_create_docs", { repoId, file, content }),
  worktreeCreate: (repoId, name, from, request) => call("worktree_create", { repoId, name, from, request: request ?? null }),
  worktreeNamePreview: (repoId, name) => call("worktree_name_preview", { repoId, name }),
  worktreePin: (path, pinned) => call("worktree_pin", { path, pinned }),
  worktreeRemove: (path, force, confirmed, deleteUnmerged) => call("worktree_remove", { path, force, confirmed, deleteUnmerged: deleteUnmerged ?? null }),
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
  worktreeFileHead: (path, file) => call("worktree_file_head", { path, file }),
  worktreeCommit: (path, files, message) => call("worktree_commit", { path, files, message }),
  worktreeStat: (path) => call("worktree_stat", { path }),
  worktreeShip: (path) => call("worktree_ship", { path }),
  worktreePush: (path) => call("worktree_push", { path }),
  worktreePull: (path) => call("worktree_pull", { path }),
  worktreeFastForward: (path) => call("worktree_fast_forward", { path }),
  worktreeRebaseFromBase: (path) => call("worktree_rebase_from_base", { path }),
  worktreeLog: (path, limit, skip) => call("worktree_log", { path, limit, skip }),
  worktreeCommitFiles: (path, id) => call("worktree_commit_files", { path, id }),
  worktreeCommitFile: (path, id, file) => call("worktree_commit_file", { path, id, file }),
  worktreeOpenCommit: (path, id) => call("worktree_open_commit", { path, id }),
  worktreeOpenFileOnHost: (path, file, line, endLine) => call("worktree_open_file_on_host", { path, file, line, endLine }),
  worktreeSync: (path) => call("worktree_sync", { path }),
  worktreeFetch: (path) => call("worktree_fetch", { path }),
  worktreeForcePush: (path, expected, confirmed) => call("worktree_force_push", { path, expected, confirmed }),
  worktreeSyncFork: (path) => call("worktree_sync_fork", { path }),
  worktreeAmend: (path, files, message, confirmed) => call("worktree_amend", { path, files, message, confirmed }),
  worktreePr: (path) => call("worktree_pr", { path }),
  worktreePrCreate: (path, draft) => call("worktree_pr_create", { path, draft }),
  ghLogins: () => call("gh_logins"),
  worktreePrChecks: (path, number) => call("worktree_pr_checks", { path, number }),
  worktreePrComments: (path, number) => call("worktree_pr_comments", { path, number }),
  worktreePrCommentPost: (path, number, draft) => call("worktree_pr_comment_post", { path, number, draft }),
  worktreePrHead: (path, number) => call("worktree_pr_head", { path, number }),
  worktreePrThreadResolve: (path, threadId, resolved) => call("worktree_pr_thread_resolve", { path, threadId, resolved }),
  worktreePrReaction: (path, subjectId, content, on) => call("worktree_pr_reaction", { path, subjectId, content, on }),
  worktreePrChecksRerun: (path, number, failedOnly) => call("worktree_pr_checks_rerun", { path, number, failedOnly }),
  worktreePrMergeInfo: (path, number) => call("worktree_pr_merge_info", { path, number }),
  worktreePrMerge: (path, number, method, headOid) => call("worktree_pr_merge", { path, number, method, headOid }),
  worktreePrOpen: (path, checks) => call("worktree_pr_open", { path, checks }),
  issuesList: (repoId, query) => call("issues_list", { repoId, query }),
  issueView: (repoId, number) => call("issue_view", { repoId, number }),
  issueResolve: (repoId, text) => call("issue_resolve", { repoId, text }),
  issueOpen: (repoId, number) => call("issue_open", { repoId, number }),
  issueCreate: (repoId, draft) => call("issue_create", { repoId, draft }),
  issueEdit: (repoId, number, edit) => call("issue_edit", { repoId, number, edit }),
  issueComment: (repoId, number, body) => call("issue_comment", { repoId, number, body }),
  issueLabels: (repoId) => call("issue_labels", { repoId }),
  issueAssignable: (repoId) => call("issue_assignable", { repoId }),
  issueTimeline: (repoId, number) => call("issue_timeline", { repoId, number }),
  prsList: (repoId, query) => call("prs_list", { repoId, query }),
  prGet: (repoId, number) => call("pr_get", { repoId, number }),
  prOpen: (repoId, number) => call("pr_open", { repoId, number }),
  prBranch: (repoId, number) => call("pr_branch", { repoId, number }),
  prBranchDiscard: (repoId, branch) => call("pr_branch_discard", { repoId, branch }),
  gitlabDetect: (repoId) => call("gitlab_detect", { repoId }),
  gitlabMrList: (repoId, state) => call("gitlab_mr_list", { repoId, filter: state }),
  gitlabMrView: (repoId, iid) => call("gitlab_mr_view", { repoId, iid }),
  gitlabMrBranch: (repoId, iid) => call("gitlab_mr_branch", { repoId, iid }),
  projectsList: (repoId) => call("projects_list", { repoId }),
  projectOpen: (repoId, number) => call("project_open", { repoId, number }),
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
  worktreeConflictResolve: (path, file, expected, how, confirmed) => call("worktree_conflict_resolve", { path, file, expected, how, confirmed }),
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
  kitUsageReport: (args) => call("kit_usage_report", { args: { ...args, utcOffsetMinutes: -new Date().getTimezoneOffset() } }),
  // A raw body, not `call`'s record: the PNG never travels as a JSON number array.
  usageShareCopyImage: (png) => invoke<void>("usage_share_copy_image", png).catch((e: unknown) => Promise.reject(toApiError(e))),
  usageSharePost: (text) => call("usage_share_post", { text }),
  kitPathsExist: (root, paths) => call("kit_paths_exist", { root, paths }),
  kitPromptHistory: (limit) => call("kit_prompt_history", { limit }),
  agentSessions: (query, refresh) => call("agent_sessions", { query, refresh }),
  sessionSearchStatus: () => call("session_search_status"),
  sessionSearchClear: () => call("session_search_clear"),
  agentSessionTail: (key, turns, chars) => call("agent_session_tail", { key, turns: turns ?? null, chars: chars ?? null }),
  agentSessionLogPath: (key) => call("agent_session_log_path", { key }),
  agentSessionOpenLog: (key) => call("agent_session_open_log", { key }),
  agentSessionRevealLog: (key) => call("agent_session_reveal_log", { key }),
  agentSessionDelete: (key) => call("agent_session_delete", { key }),
  agentSessionsSkipped: () => call("agent_sessions_skipped"),
  agentContextUsage: (session) => call("agent_context_usage", { session }),
  notesList: () => call("notes_list"),
  notesGet: (tab) => call("notes_get", { tab }),
  notesPut: (note) => call("notes_put", { note }),
  notesDelete: (tab) => call("notes_delete", { tab }),
  quickCommandsList: () => call("quick_commands_list"),
  quickCommandUpsert: (item) => call("quick_command_upsert", { item }),
  quickCommandDelete: (id) => call("quick_command_delete", { id }),
  quickCommandsMove: (id, to) => call("quick_commands_move", { id, to }),
  repoFileCommands: (worktree) => call("repo_file_commands", { worktree }),
  repoFileCommandsTrust: (worktree, hash) => call("repo_file_commands_trust", { worktree, hash }),
  quickCommandUsed: (id) => call("quick_command_used", { id }),
  quickCommandsRecent: () => call("quick_commands_recent"),
  terminalSetsList: () => call("terminal_sets_list"),
  terminalSetUpsert: (item) => call("terminal_set_upsert", { item }),
  terminalSetDelete: (id) => call("terminal_set_delete", { id }),
  startupPresetsList: () => call("startup_presets_list"),
  startupPresetUpsert: (item) => call("startup_preset_upsert", { item }),
  startupPresetDelete: (id) => call("startup_preset_delete", { id }),
  fileRead: (worktree, rel) => call("file_read", { worktree, rel }),
  fileWrite: (worktree, rel, text, eol, expected) => call("file_write", { worktree, rel, text, eol, expected }),
  fileCreate: (worktree, rel, dir) => call("file_create", { worktree, rel, dir }),
  fileRename: (worktree, from, to) => call("file_rename", { worktree, from, to }),
  fileTrash: (worktree, rel) => call("file_trash", { worktree, rel }),
  fileReveal: (worktree, rel) => call("file_reveal", { worktree, rel }),
  fileLinksResolve: (worktree, paths, cwd) => call("file_links_resolve", { worktree, paths, ...(cwd !== undefined ? { cwd } : {}) }),
  openUrl: (url) => call("open_url", { url }),
  fileRemoteUrl: (worktree, rel, line, endLine) => call("file_remote_url", { worktree, rel, line, endLine }),
  fileBytes: async (worktree, rel) => new Uint8Array(await call<ArrayBuffer | number[]>("file_bytes", { worktree, rel })),
  fileOpenDefault: (worktree, rel) => call("file_open_default", { worktree, rel }),
  filesList: (worktree) => call("files_list", { worktree }),
  filesSearch(worktree, query, id, onEvent) {
    const channel = new Channel<SearchEvent>();
    channel.onmessage = onEvent;
    return call("files_search", { worktree, query, id, onEvent: channel });
  },
  filesSearchCancel: (id) => call("files_search_cancel", { id }),
  filesWatch(worktree, id, onEvent) {
    const channel = new Channel<FsChanged>();
    channel.onmessage = onEvent;
    return call("files_watch", { worktree, id, onEvent: channel });
  },
  filesUnwatch: (id) => call("files_unwatch", { id }),
  editorSettings: () => call("editor_settings_get"),
  editorSettingsPut: (settings) => call("editor_settings_put", { settings }),
  navigationSettings: () => call("navigation_settings_get"),
  navigationSettingsPut: (settings) => call("navigation_settings_put", { settings }),
  diffSettings: () => call("diff_settings_get"),
  diffSettingsPut: (settings) => call("diff_settings_put", { settings }),
  agentsSettings: () => call("agents_settings_get"),
  agentsSettingsPut: (settings) => call("agents_settings_put", { settings }),
  pathEffective: () => call("path_effective"),
  orchestrationSettings: () => call("orchestration_settings_get"),
  orchestrationSettingsPut: (settings) => call("orchestration_settings_put", { settings }),
  keepAwake: () => call("keep_awake_get"),
  keepAwakeSet: (mode) => call("keep_awake_set", { mode }),
  keepAwakeAgents: (working) => call("keep_awake_agents", { working }),
  onKeepAwakeChanged: (cb) => listen<AwakeView>("keep-awake://changed", (e) => cb(e.payload)),
  appStats: () => call("app_stats_get"),
  appStatsBusy: (tabId, working) => call("app_stats_busy", { tabId, working }),
  termTailRead: (tabId, limitLines) => call("term_tail_read", { id: tabId, limitLines }),
  transcriptSave: (defaultName, text) => call("transcript_save", { defaultName, text }),
  resourcesSnapshot: () => call("resources_snapshot"),
  portsScan: (worktrees, force) => call("ports_scan", { worktrees, force }),
  portsStop: (worktrees, id, consent) => call("ports_stop", { worktrees, id, confirmed: consent.confirmed, outsideTerminal: consent.outsideTerminal }),
  portsOpen: (id) => call("ports_open", { id }),
  sshHostsList: () => call("ssh_hosts_list"),
  sshHostSave: (host) => call("ssh_host_save", { host }),
  sshHostRemove: (id) => call("ssh_host_remove", { id }),
  sshHostsRemoveMany: (ids) => call("ssh_hosts_remove_many", { ids }),
  sshConfigSync: () => call("ssh_config_sync"),
  sshHostTest: (id) => call("ssh_host_test", { id }),
  sshConnect: (id) => call("ssh_connect", { id }),
  sshDisconnect: (id) => call("ssh_disconnect", { id }),
  sshConnectionsList: () => call("ssh_connections_list"),
  onSshState: (cb) => listen<SshConnectionView>("ssh://state", (e) => cb(e.payload)),
  onSshAuthPrompt: (cb) => listen<SshAuthPrompt>("ssh://auth-prompt", (e) => cb(e.payload)),
  onSshAuthClosed: (cb) => listen<{ requestId: string }>("ssh://auth-closed", (e) => cb(e.payload.requestId)),
  sshAuthReply: (requestId, answer) => call("ssh_auth_reply", { requestId, answer }),
  onPortsAdvertised: (cb) => listen<{ worktree: string }>("ports://advertised", (e) => cb(e.payload.worktree)),
  automationsSettings: () => call("automations_settings_get"),
  automationsSettingsPut: (settings) => call("automations_settings_put", { settings }),
  networkSettings: () => call("network_settings_get"),
  networkSettingsPut: (settings) => call("network_settings_put", { settings }),
  machineName: () => call("machine_name_get"),
  usageSettings: () => call("usage_settings_get"),
  usageSettingsPut: (settings) => call("usage_settings_put", { settings }),
  layoutLoad: () => call("layout_load"),
  layoutSave: (snapshot) => call("layout_save", { snapshot }),
  cliTabsReport: (tabs, selected) => call("cli_tabs_report", { tabs, selected }),
  cliApprove: (request, allow) => call("cli_approve", { request, allow }),
  onWorkspaceChanged: (cb) => listen("workspace://changed", () => cb()),
  onCliOpenTab: (cb) => listen<CliOpenTab>("cli://open-tab", (e) => cb(e.payload)),
  automationsList: () => call("automations_list"),
  automationRuns: (automationId) => call("automation_runs", { automationId }),
  automationRunsSummary: (range) => call("automation_runs_summary", { range: range ?? null }),
  automationCreate: (input) => call("automation_create", { input }),
  automationUpdate: (id, input) => call("automation_update", { id, input }),
  automationSetEnabled: (id, enabled) => call("automation_set_enabled", { id, enabled }),
  automationDelete: (id) => call("automation_delete", { id }),
  automationRunNow: (id) => call("automation_run_now", { id }),
  automationDescribe: (expr, timezone) => call("automation_describe", { expr, timezone }),
  automationValidateSchedule: (expr, timezone) => call("automation_validate_schedule", { expr, timezone }),
  automationNextRuns: (expr, timezone, dtstart, count) => call("automation_next_runs", { expr, timezone, dtstart, count }),
  automationUiReady: () => call("automation_ui_ready"),
  automationDispatchResult: (result) => call("automation_dispatch_result", { result }),
  automationRunFinish: (finish) => call("automation_run_finish", { finish }),
  onAutomationDispatch: (cb) => listen<AutomationDispatch>("automation://dispatch", (e) => cb(e.payload)),
  onAutomationsChanged: (cb) => listen<AutomationsChanged>("automations://changed", (e) => cb(e.payload)),
  onCliAsk: (cb) => listen<CliAsk>("cli://ask", (e) => cb(e.payload)),
  onCliOpenFile: (cb) => listen<CliOpenFile>("cli://open-file", (e) => cb(e.payload)),
  orchestrationSkillStatus: () => call("orchestration_skill_status"),
  orchestrationSkillInstall: (force = false) => call("orchestration_skill_install", { force }),
  orchestrationSkillUninstall: (force = false) => call("orchestration_skill_uninstall", { force }),
  orchestrationWorkerLifetime: (tab) => call("orchestration_worker_lifetime", { tab }),
  orchestrationWorkerKeepOpen: (tab, keep) => call("orchestration_worker_keep_open", { tab, keep }),
  orchestrationWorkerOpened: (dispatch, outcome) => call("orchestration_worker_opened", { dispatch, outcome }),
  orchestrationReadAnswer: (request, text) => call("orchestration_read_answer", { request, text }),
  onOrchestrationOpenWorker: (cb) => listen<WorkerOpen>("orchestration://open-worker", (e) => cb(e.payload)),
  onOrchestrationCloseWorker: (cb) => listen<WorkerClose>("orchestration://close-worker", (e) => cb(e.payload)),
  onOrchestrationReadTab: (cb) => listen<ReadTab>("orchestration://read-tab", (e) => cb(e.payload)),
  onOrchestrationWorkerChanged: (cb) => listen<WorkerChanged>("orchestration://worker-changed", (e) => cb(e.payload)),
  crashRecordRender: (crash) => call("crash_record_render", { crash }),
  crashBreadcrumb: (name, data) => call("crash_breadcrumb", { name, data }),
  crashTakePending: () => call("crash_take_pending"),
  crashLatest: () => call("crash_latest"),
  crashDismiss: (id) => call("crash_dismiss", { id }),
  startupReport: () => call("startup_report"),
  startupMark: (step) => call("startup_mark", { step }),
  appRelaunch: () => call("app_relaunch"),
  diagnosticsExport: (defaultName) => call("diagnostics_export", { defaultName }),
  diagnosticsRevealExport: (path) => call("diagnostics_reveal_export", { path }),
  diagnosticsRevealLogs: () => call("diagnostics_reveal_logs"),
  composerDraftGet: (tabId) => call("composer_draft_get", { tabId }),
  composerDraftPut: (tabId, text) => call("composer_draft_put", { tabId, text }),
  composerDraftClear: (tabId) => call("composer_draft_clear", { tabId }),
  promptTemplatesList: () => call("prompt_templates_list"),
  promptTemplatesPut: (template) => call("prompt_templates_put", { template }),
  promptTemplatesDelete: (id) => call("prompt_templates_delete", { id }),
  promptQueueList: () => call("prompt_queue_list"),
  promptQueueAdd: (item) => call("prompt_queue_add", { item }),
  promptQueueUpdate: (id, text, when) => call("prompt_queue_update", { id, text, when }),
  promptQueueDelete: (id) => call("prompt_queue_delete", { id }),
  promptQueueReorder: (id, delta) => call("prompt_queue_reorder", { id, delta }),
  promptQueueSendNow: (id) => call("prompt_queue_send_now", { id }),
  promptQueueReport: (id, report) => call("prompt_queue_report", { id, report }),
  promptQueueFacts: (facts) => call("prompt_queue_facts", { facts }),
  onPromptQueueDue: (cb) => listen<PromptQueueDue>("prompt-queue://due", (e) => cb(e.payload)),
  onPromptQueueChanged: (cb) => listen<PromptQueueChanged>("prompt-queue://changed", (e) => cb(e.payload)),
  accountsRouting: () => call("accounts_routing"),
  accountRoutingSet: (routing) => call("account_routing_set", { routing }),
  accountUseNext: (provider, avoid) => call("account_use_next", { provider, avoid }),
  onQuotaAlert: (cb) => listen<QuotaAlert>("accounts://quota-alert", (e) => cb(e.payload)),
  configExport: (sections) => call("config_export", { sections }),
  configImportPreview: (path) => call("config_import_preview", { path }),
  configImportApply: (path, sections) => call("config_import_apply", { path, sections }),
  repoEnvSecrets: (repoId) => call("repo_env_secrets", { repoId }),
  repoEnvSecretSet: (repoId, key, value) => call("repo_env_secret_set", { repoId, key, value }),
  repoEnvSecretClear: (repoId, key) => call("repo_env_secret_clear", { repoId, key }),
  repoEnvPreview: (repoId) => call("repo_env_preview", { repoId }),
  orchestrationMission: () => call("orchestration_mission"),
  orchestrationMissionSettingsPut: (settings) => call("orchestration_mission_settings_put", { settings }),
  orchestrationLinkPut: (from, to) => call("orchestration_link_put", { from, to }),
  orchestrationLinkGrant: (from, to, grant, on) => call("orchestration_link_grant", { from, to, grant, on }),
  orchestrationLinkRetarget: (from, to, target) => call("orchestration_link_retarget", { from, to, target }),
  orchestrationLinkRemove: (from, to) => call("orchestration_link_remove", { from, to }),
  orchestrationNudge: (tab) => call("orchestration_nudge", { tab }),
  orchestrationHandoff: (from, to, text) => call("orchestration_handoff", { from, to, text }),
  orchestrationTabStop: (tab) => call("orchestration_tab_stop", { tab }),
  orchestrationWorkerFailover: (tab) => call("orchestration_worker_failover", { tab }),
  onOrchestrationFailover: (cb) => listen<WorkerFailover>("orchestration://failover", (e) => cb(e.payload)),
  agentConversation: (key, from, limit) => call("agent_conversation", { key, from: from ?? null, limit: limit ?? null }),
};

const DEMO_CRASH: CrashReport = {
  id: "demo-crash",
  createdAt: Date.now() - 60_000,
  status: "pending",
  source: "main",
  process: "app",
  reason: "panic",
  exitCode: null,
  appVersion: "0.0.0",
  platform: "demo",
  arch: "demo",
  details: [
    { key: "location", value: "src/workspace.rs:10:5" },
    { key: "thread", value: "main" },
    { key: "message", value: "index out of bounds" },
  ],
  breadcrumbs: [{ at: Date.now() - 61_000, name: "renderer_error", data: [{ key: "message", value: "demo" }] }],
};

function browserApi(): Api {
  const params = new URLSearchParams(location.search);
  // `?account=in` previews the signed-in xDev ID.
  const xdevId = params.get("account") === "in" ? "signedIn" : "signedOut";
  // `?update=0.4.0` simulates a downloaded update, so the restart button can be previewed.
  const pending = params.get("update");
  const mock = createMockApi(DEMO_SEED, { repo: !params.has("norepo"), commits: DEMO_COMMITS, runDelayMs: 4000, automationsDemo: true, xdevId, update: pending });
  // Lets the preview simulate an AI agent or another editor from the devtools console.
  Object.assign(window, { xdevMock: mock });
  // The preview lands in the demo vault so the main layout is reachable without a dialog;
  // `?welcome` simulates a first launch instead.
  const firstRun = params.has("welcome");
  // `?crash` seeds a pending panic report; `?startupfail` a failed layout restore.
  if (params.has("crash")) mock.__crash(DEMO_CRASH);
  if (params.has("startupfail")) mock.__startupFail("layout.restore", "layout.json did not parse");
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
