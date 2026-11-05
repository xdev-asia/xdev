import { useCallback, useEffect, useRef, useState } from "react";
import { toApiError, type Api, type ApiError } from "@/api";

/** How long typing pauses before the draft is stored. */
export const DRAFT_SAVE_MS = 400;

/**
 * The composer text of `tabId`, kept in the Rust draft store: read when the tab changes, stored a
 * moment after typing stops and at once when the tab changes, forgotten by `clear`.
 */
export function useDraft(api: Api, tabId: string | null): {
  text: string;
  setText(text: string): void;
  clear(): Promise<void>;
  error: ApiError["code"] | null;
} {
  const [text, setTextState] = useState("");
  const [error, setError] = useState<ApiError["code"] | null>(null);
  // The edit not stored yet: which tab it belongs to and its text.
  const pending = useRef<{ tab: string; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    api.composerDraftPut(p.tab, p.text).then(
      () => setError(null),
      (e: unknown) => setError(toApiError(e).code),
    );
  }, [api]);

  useEffect(() => {
    let live = true;
    setTextState("");
    setError(null);
    if (tabId !== null) {
      api.composerDraftGet(tabId).then(
        (draft) => {
          // Typing that started before the draft came back wins.
          if (live && pending.current === null && draft !== null) setTextState(draft);
        },
        () => {},
      );
    }
    return () => {
      live = false;
      flush();
    };
    // `flush` reads refs and `api` only; the draft reloads when the tab changes, not on each draw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tabId]);

  const setText = useCallback(
    (next: string) => {
      setTextState(next);
      if (tabId === null) return;
      pending.current = { tab: tabId, text: next };
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, DRAFT_SAVE_MS);
    },
    [tabId, flush],
  );

  const clear = useCallback(async () => {
    clearTimeout(timer.current);
    pending.current = null;
    setTextState("");
    setError(null);
    if (tabId !== null) await api.composerDraftClear(tabId).catch(() => false);
  }, [api, tabId]);

  return { text, setText, clear, error };
}
