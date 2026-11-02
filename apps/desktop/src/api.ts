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
    | "bad_registry"
    | "bad_reserve";
  detail?: string;
};
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
  state: "logged_in" | "logged_out" | "no_claude" | "error";
  email: string | null; plan: string | null; org: string | null;
};
export type Account = { name: string; provider: "claude"; dir: string; status: AccountStatus };
export type Accounts = { reservePercent: number; accounts: Account[] };
export type QuotaWindow = { key: string; utilization: number | null; resetsAt: string | null };
export type Quota = {
  name: string;
  state: "ok" | "reserve" | "full" | "unknown";
  reason: "no_credentials" | "expired" | "unavailable" | "logged_out" | "no_claude" | null;
  windows: QuotaWindow[];
};
export type LoginStart = { opened: boolean; command: string };

export interface Api {
  accounts(): Promise<Accounts>;
  quota(): Promise<Quota[]>;
  addAccount(name: string): Promise<Account>;
  loginAccount(name: string): Promise<LoginStart>;
  removeAccount(name: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  openVault(path: string): Promise<DocEntry[]>;
  lastVault(): Promise<string | null>;
  listDocs(): Promise<DocEntry[]>;
  readDoc(path: string): Promise<string>;
  writeDoc(path: string, content: string): Promise<void>;
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
  "bad_registry",
  "bad_reserve",
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
  addAccount: (name) => call("account_add", { name }),
  loginAccount: (name) => call("account_login", { name }),
  removeAccount: (name) => call("account_remove", { name }),
  async pickFolder() {
    const picked = await open({ directory: true });
    return typeof picked === "string" ? picked : null;
  },
  openVault: (path) => call("open_vault", { path }),
  lastVault: () => call("last_vault"),
  listDocs: () => call("list_docs"),
  readDoc: (path) => call("read_doc", { path }),
  writeDoc: (path, content) => call("write_doc", { path, content }),
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
  const mock = createMockApi(DEMO_SEED, { repo: !params.has("norepo"), commits: DEMO_COMMITS });
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
