import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { createMockApi, DEMO_ROOT, DEMO_SEED } from "./mockApi";

export { createMockApi };

export type DocEntry = { path: string; title: string; size: number; skipped: null | "too_large" | "not_utf8" };
export type SearchHit = { path: string; title: string; snippet: string };
export type ApiError = {
  code: "not_found" | "outside_vault" | "no_vault" | "io" | "not_utf8" | "too_large";
  detail?: string;
};

export interface Api {
  pickFolder(): Promise<string | null>;
  openVault(path: string): Promise<DocEntry[]>;
  lastVault(): Promise<string | null>;
  listDocs(): Promise<DocEntry[]>;
  readDoc(path: string): Promise<string>;
  writeDoc(path: string, content: string): Promise<void>;
  search(query: string, limit: number): Promise<SearchHit[]>;
  onVaultChanged(cb: (paths: string[]) => void): Promise<() => void>;
}

const ERROR_CODES: readonly ApiError["code"][] = ["not_found", "outside_vault", "no_vault", "io", "not_utf8", "too_large"];

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
};

function browserApi(): Api {
  const mock = createMockApi(DEMO_SEED);
  // The preview lands in the demo vault so the main layout is reachable without a dialog;
  // `?welcome` simulates a first launch instead.
  const firstRun = new URLSearchParams(location.search).has("welcome");
  return { ...mock, lastVault: async () => (await mock.lastVault()) ?? (firstRun ? null : DEMO_ROOT) };
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const api: Api = isTauri() ? tauriApi : typeof window !== "undefined" ? browserApi() : createMockApi(DEMO_SEED);
