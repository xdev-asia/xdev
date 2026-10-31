import { useCallback, useEffect, useRef, useState } from "react";
import { toApiError, type Api, type ApiError, type Change, type VcsState } from "../api";
import { sortChanges } from "./changes";

const REFRESH_DEBOUNCE_MS = 200;

export type Problem = { code: ApiError["code"] | "unsaved"; detail?: string };
export type ChangesStatus = VcsState["status"] | "loading" | "error";

export type Changes = {
  status: ChangesStatus;
  changes: Change[];
  busy: boolean;
  error?: Problem;
  // Bumps on every successful refresh, so views showing file content know to reload it.
  revision: number;
  refresh(): void;
  init(): Promise<void>;
  approve(paths: string[], message: string): Promise<boolean>;
  reject(paths: string[]): Promise<boolean>;
  clearError(): void;
};

// `flush` saves the open doc first, so an action applies to what the user sees (spec: unsaved edits).
export function useChanges(api: Api, flush: () => Promise<boolean>): Changes {
  const [status, setStatus] = useState<ChangesStatus>("loading");
  const [changes, setChanges] = useState<Change[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem>();
  // Kept apart from action errors, so the next good refresh clears it without hiding a failed approve.
  const [loadError, setLoadError] = useState<Problem>();
  const [revision, setRevision] = useState(0);
  const seq = useRef(0);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const { status } = await api.vcsState();
      const list = status === "ok" ? sortChanges(await api.listChanges()) : [];
      // A newer refresh started meanwhile; its answer is the one to keep.
      if (mine !== seq.current) return;
      setStatus(status);
      setChanges(list);
      setLoadError(undefined);
      setRevision((r) => r + 1);
    } catch (e) {
      if (mine !== seq.current) return;
      setStatus("error");
      setChanges([]);
      setLoadError(toApiError(e));
    }
  }, [api]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // An agent writing many files fires many events; one git status at the end is enough.
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
    };
    let off: (() => void) | undefined;
    let disposed = false;
    void load();
    void api.onVaultChanged(soon).then((unlisten) => (disposed ? unlisten() : (off = unlisten)));
    // Commits made in a terminal do not touch the docs, so the watcher never reports them.
    window.addEventListener("focus", soon);
    return () => {
      disposed = true;
      off?.();
      clearTimeout(timer);
      window.removeEventListener("focus", soon);
    };
  }, [api, load]);

  const run = useCallback(
    async (action: () => Promise<unknown>, needsFlush: boolean): Promise<boolean> => {
      setBusy(true);
      setError(undefined);
      try {
        if (needsFlush && !(await flushRef.current())) {
          setError({ code: "unsaved" });
          return false;
        }
        await action();
        return true;
      } catch (e) {
        setError(toApiError(e));
        return false;
      } finally {
        setBusy(false);
        await load();
      }
    },
    [load],
  );

  return {
    status,
    changes,
    busy,
    error: error ?? loadError,
    revision,
    refresh: () => void load(),
    init: async () => void (await run(() => api.initRepo(), false)),
    approve: (paths, message) => run(() => api.approve(paths, message), true),
    reject: (paths) => run(() => api.reject(paths), true),
    clearError: () => setError(undefined),
  };
}
