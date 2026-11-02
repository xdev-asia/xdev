import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Target } from "./doc/frontmatter";
import { createMockApi, DEMO_AI_EDIT, DEMO_COMMITS, DEMO_OUTSIDE_EDIT, DEMO_ROOT, DEMO_SEED } from "./mockApi";

export { createMockApi };
export type { Target };

export type DocEntry = { path: string; title: string; size: number; skipped: null | "too_large" | "not_utf8" };
export type SearchHit = { path: string; title: string; snippet: string };
export type ApiError = {
  code:
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
    | "binary";
  detail?: string;
};
export type VaultSetup = { prompt: boolean; defaultPath: string };
export type VcsState = { status: "ok" | "no_repo" | "no_git" };
export type ChangeKind = "added" | "modified" | "deleted";
// `note` is the summary an agent gave with an `ai` change; null for the other origins.
// `hash` is the text on disk (null when deleted); approve and reject send it back so
// the core can refuse a change edited after the person looked at it.
export type Change = {
  path: string;
  kind: ChangeKind;
  origin: "app" | "outside" | "ai";
  note: string | null;
  hash: string | null;
};
export type Seen = Pick<Change, "path" | "hash">;
// `time` is unix seconds, `message` the subject line.
export type Commit = { id: string; author: string; time: number; message: string };
// `none`: the doc declares no `covers`, so there is nothing to check.
export type DocState = "none" | "fresh" | "stale" | "unverified" | "unknown";
export type Freshness = {
  state: DocState;
  covers: string[];
  verified: string | null;
  // Full id of HEAD; null without git or commits, which is when a doc cannot be marked verified.
  head: string | null;
  // Newest first, at most 20; `count` is the whole range.
  commits: Commit[];
  count: number;
};
export type StaleDoc = { path: string; title: string; state: "stale" | "unverified" | "unknown"; count: number };
export type DocLink = { path: string; title: string };
export type ExportStatus = "new" | "changed" | "unchanged" | "foreign";
// `path` is relative to the export root with "/" separators; `old` is null when the file does not exist yet.
export type ExportFile = { path: string; status: ExportStatus; old: string | null; new: string; hash: string };
export type ExportPlan = {
  root: string;
  files: ExportFile[];
  docs: { path: string; title: string; targets: Target[] }[];
  tokens: number;
};
export type Expected = { path: string; hash: string };

export type AccountStatus = {
  state: "logged_in" | "logged_out" | "no_claude" | "no_codex" | "error";
  email: string | null; plan: string | null; org: string | null;
};
export type Provider = "claude" | "codex";
export const PROVIDERS: readonly Provider[] = ["claude", "codex"];
export type Account = { name: string; provider: Provider; dir: string; status: AccountStatus };
export type Accounts = { reservePercent: number; accounts: Account[] };
export type QuotaWindow = { key: string; utilization: number | null; resetsAt: string | null };
export type Quota = {
  name: string;
  state: "ok" | "reserve" | "full" | "unknown";
  reason: "no_credentials" | "expired" | "unavailable" | "logged_out" | "no_claude" | "no_codex" | "no_sessions" | null;
  windows: QuotaWindow[];
  // Codex limits come from its newest session file, so they are only as fresh as that; null for Claude.
  asOf: string | null;
};
export type LoginStart = { opened: boolean; command: string };

// Tasks keep the agent crate's own snake_case record, the same JSON `xdev task show --json` prints.
// Times are unix seconds.
export type TaskState = "ready" | "running" | "paused" | "review" | "failed" | "merged" | "discarded";
export type TaskRun = {
  started: number;
  ended: number | null;
  session_id: string | null;
  cost_usd: number | null;
  is_error: boolean;
  summary: string;
};
// Null counts are a binary file.
export type TaskFile = { path: string; added: number | null; removed: number | null };
// `exit` is null when the command was killed or could not start.
export type TaskTest = { command: string[]; exit: number | null; output_tail: string };
export type TaskEvidence = { base: string; head: string; files: TaskFile[]; test: TaskTest | null };
export type Task = {
  id: string;
  goal: string;
  repo: string;
  base: string;
  branch: string;
  worktree: string;
  state: TaskState;
  runs: TaskRun[];
  evidence: TaskEvidence | null;
  approval: { at: number; merge_commit: string } | null;
  created: number;
};
// `defaultRepo` is the open vault's git root; `policyPath` is where the person changes what the gate allows.
export type TasksContext = { defaultRepo: string | null; policyPath: string | null };
// A file at the evidence's base and head; null where it does not exist.
export type FileDiff = { old: string | null; new: string | null };

export interface Api {
  accounts(): Promise<Accounts>;
  quota(): Promise<Quota[]>;
  addAccount(name: string, provider: Provider): Promise<Account>;
  loginAccount(name: string): Promise<LoginStart>;
  removeAccount(name: string): Promise<void>;
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
}

function seen({ path, hash }: Seen): Seen {
  return { path, hash };
}

export const ERROR_CODES: readonly ApiError["code"][] = [
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
  accounts: () => call("accounts_list"),
  quota: () => call("accounts_quota"),
  addAccount: (name, provider) => call("account_add", { name, provider }),
  loginAccount: (name) => call("account_login", { name }),
  removeAccount: (name) => call("account_remove", { name }),
  tasksContext: () => call("tasks_context"),
  tasks: () => call("tasks_list"),
  task: (id) => call("task_get", { id }),
  newTask: (repo, goal) => call("task_new", { repo, goal }),
  runTask: (id, account, test) => call("task_run", { id, account, test }),
  resumeTask: (id, account) => call("task_resume", { id, account }),
  approveTask: (id) => call("task_approve", { id }),
  discardTask: (id) => call("task_discard", { id }),
  taskFileDiff: (id, path) => call("task_file_diff", { id, path }),
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
  onVaultChanged: (cb) => listen<{ paths: string[] }>("vault://changed", (e) => cb(e.payload.paths)),
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
