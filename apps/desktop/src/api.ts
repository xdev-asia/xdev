import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { createMockApi, DEMO_OUTSIDE_EDIT, DEMO_ROOT, DEMO_SEED } from "./mockApi";

export { createMockApi };

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
    | "git_identity";
  detail?: string;
};
export type VcsState = { status: "ok" | "no_repo" | "no_git" };
export type ChangeKind = "added" | "modified" | "deleted";
export type Change = { path: string; kind: ChangeKind; origin: "app" | "outside" };
// `time` is unix seconds, `message` the subject line.
export type Commit = { id: string; author: string; time: number; message: string };

export interface Api {
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
  approve(paths: string[], message: string): Promise<string | null>;
  reject(paths: string[]): Promise<void>;
  history(path: string, limit: number): Promise<Commit[]>;
  readVersion(path: string, id: string): Promise<string | null>;
  restoreVersion(path: string, id: string): Promise<void>;
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
  approve: (paths, message) => call("approve", { paths, message }),
  reject: (paths) => call("reject", { paths }),
  history: (path, limit) => call("history", { path, limit }),
  readVersion: (path, id) => call("read_version", { path, id }),
  restoreVersion: (path, id) => call("restore_version", { path, id }),
};

function browserApi(): Api {
  const params = new URLSearchParams(location.search);
  const mock = createMockApi(DEMO_SEED, { repo: !params.has("norepo") });
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
      // One pending outside edit, so the Changes tab has something to review.
      if (!seeded && (await mock.vcsState()).status === "ok") mock.__editOutside("README.md", DEMO_OUTSIDE_EDIT);
      seeded = true;
      return docs;
    },
  };
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const api: Api = isTauri() ? tauriApi : typeof window !== "undefined" ? browserApi() : createMockApi(DEMO_SEED);
