import { useCallback, useEffect, useRef, useState } from "react";
import { toApiError, type Api } from "../api";
import { docReducer, initialDocState, isDirty, type DocAction, type DocState } from "./docState";

const AUTOSAVE_MS = 1000;

export function useDoc(api: Api): {
  state: DocState;
  open(path: string): void;
  edit(c: string): void;
  save(): void;
  resolve(choice: "reload" | "keep"): void;
} {
  const [state, setState] = useState(initialDocState);
  // Async callbacks need the latest state, not the one captured by their render.
  const ref = useRef(state);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inFlight = useRef<Promise<void> | null>(null);
  // Lets the watcher echo of a write be recognised even before the write resolves.
  const lastWrite = useRef<string | null>(null);
  const loadSeq = useRef(0);

  const dispatch = useCallback((a: DocAction) => {
    ref.current = docReducer(ref.current, a);
    setState(ref.current);
  }, []);

  const saveNow = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current);
    // One write at a time, so a slow write can never land after a newer one.
    while (inFlight.current) await inFlight.current;
    const { path, draft, status } = ref.current;
    if (path === null || !isDirty(ref.current) || status === "conflict" || status === "loading") return;
    dispatch({ type: "saveStarted" });
    lastWrite.current = draft;
    const write = api
      .writeDoc(path, draft)
      .then(
        () => dispatch({ type: "saved", content: draft }),
        (e: unknown) => dispatch({ type: "failed", code: toApiError(e).code }),
      )
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = write;
    await write;
  }, [api, dispatch]);

  const open = useCallback(
    async (path: string) => {
      const seq = ++loadSeq.current;
      await saveNow();
      // Switching away now would drop edits that failed to save or are in conflict; the UI shows why.
      if (isDirty(ref.current) || seq !== loadSeq.current) return;
      dispatch({ type: "loadStarted", path });
      lastWrite.current = null;
      try {
        const content = await api.readDoc(path);
        if (seq === loadSeq.current) dispatch({ type: "loaded", path, content });
      } catch (e) {
        if (seq === loadSeq.current) dispatch({ type: "failed", code: toApiError(e).code });
      }
    },
    [api, dispatch, saveNow],
  );

  const edit = useCallback(
    (content: string) => {
      dispatch({ type: "edited", content });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void saveNow(), AUTOSAVE_MS);
    },
    [dispatch, saveNow],
  );

  const resolve = useCallback(
    (choice: "reload" | "keep") => {
      dispatch({ type: choice === "reload" ? "resolveReload" : "resolveKeepMine" });
      if (choice === "keep") void saveNow();
    },
    [dispatch, saveNow],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveNow();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveNow]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    void api
      .onVaultChanged(async (paths) => {
        const { path, status } = ref.current;
        if (path === null || status === "loading" || !paths.includes(path)) return;
        try {
          const content = await api.readDoc(path);
          if (ref.current.path !== path || content === lastWrite.current) return;
          dispatch({ type: "externalChange", content });
        } catch (e) {
          // Typically the file was deleted; the draft stays so the next save can recreate it.
          if (ref.current.path === path) dispatch({ type: "failed", code: toApiError(e).code });
        }
      })
      .then((unlisten) => (disposed ? unlisten() : (off = unlisten)));
    return () => {
      disposed = true;
      off?.();
      clearTimeout(timer.current);
    };
  }, [api, dispatch]);

  return {
    state,
    open: (path) => void open(path),
    edit,
    save: () => void saveNow(),
    resolve,
  };
}
