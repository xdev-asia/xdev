import { useEffect, useRef, useState } from "react";
import type { Api, RepoView } from "@/api";
import { withFloatingSave } from "@/floating/floatingPersist";
import { fileTabs } from "@/files/fileTabs";
import type { useI18n } from "@/i18n";
import { getTerminalSettings } from "@/terminal/terminalSettings";
import { currentCloseWindow, openRestoredFile, restoreLayout, startLayoutSave, undoRestore } from "@/workspace/layoutPersist";
import { askQuit, guardClose, installCloseGuard, type QuitAsk, type QuitChoice } from "@/workspace/quitGuard";
import type { Sessions } from "@/workspace/sessions";
import { pushToast } from "@/workspace/toastStore";

type T = ReturnType<typeof useI18n>["t"];

/** The saved tab layout comes back once per run, is saved from then on, and the window asks before it closes. */
export function useShellLayoutRestore(o: { api: Api; sessions: Sessions | null; repos: RepoView[] | null; t: T; live: { t: T } }) {
  const { api, sessions, repos, t, live } = o;
  // "On quit: Ask": the question shown while the window waits to close.
  const [quitting, setQuitting] = useState<{ ask: QuitAsk; answer(choice: QuitChoice): void } | null>(null);
  // Layout restore: once per run, after the registry is known and before the saver starts (a saver that
  // ran first would replace the stored layout with an empty one). Nothing runs without a worktree.
  const restoreStarted = useRef(false);
  const saver = useRef<ReturnType<typeof startLayoutSave> | null>(null);
  const flushOnClose = useRef(() => saver.current?.flush());
  // The layout restore has ended (or there was nothing to restore): automation runs may start, and find the tabs they reuse.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (sessions && repos && repos.length === 0) setRestored(true);
    if (!sessions || !repos || repos.length === 0 || restoreStarted.current) return;
    restoreStarted.current = true;
    const known = new Set(repos.flatMap((r) => r.worktrees.map((w) => w.path)));
    // A missing repo lists no worktrees though they may still exist: then the unknown ones stay saved.
    const incomplete = repos.some((r) => r.missing);
    void restoreLayout(api, sessions, (w) => known.has(w), openRestoredFile(api, fileTabs), () => incomplete, (key) => t(key)).then((got) => {
      // The store was replaced (dev double mount) while the restore ran: this run is over.
      if (!restoreStarted.current) return;
      saver.current = startLayoutSave(api, sessions);
      if (typeof window !== "undefined") window.addEventListener("beforeunload", flushOnClose.current);
      if (!got || got.report.opened.length === 0) return;
      const { resumed, fresh, opened } = got.report;
      pushToast({
        text: live.t("layout.restored", { resumed, fresh }),
        actions: [{ label: live.t("layout.undo"), run: () => void undoRestore(sessions, opened) }],
      });
    }).finally(() => {
      if (restoreStarted.current) setRestored(true);
    });
  }, [sessions, repos]);
  // The close guard, set up once at mount: it looks the saver and the tabs up when a close fires, so it
  // also works on the welcome screen, with no repos, and while the layout restore still runs.
  const sessionsNow = useRef<Sessions | null>(null);
  sessionsNow.current = sessions;
  useEffect(() => {
    let stopped = false;
    let stop = () => {};
    void currentCloseWindow().then((win) => {
      if (stopped) return;
      stop = installCloseGuard(
        win,
        () => withFloatingSave(saver.current),
        () =>
          guardClose(api, { title: live.t("shell.tray.tooltip"), body: live.t("shell.tray.notice") }, () =>
            askQuit(
              api,
              () => getTerminalSettings().onQuit,
              () => sessionsNow.current?.worktrees().flatMap((w) => sessionsNow.current?.tabs(w) ?? []) ?? [],
              (ask) =>
                new Promise<QuitChoice>((resolve) =>
                  setQuitting({
                    ask,
                    answer: (choice) => {
                      setQuitting(null);
                      resolve(choice);
                    },
                  }),
                ),
            ),
          ),
      );
    });
    return () => {
      stopped = true;
      stop();
    };
  }, [api]);
  useEffect(() => {
    const close = flushOnClose.current;
    return () => {
      restoreStarted.current = false;
      saver.current?.stop();
      saver.current = null;
      if (typeof window !== "undefined") window.removeEventListener("beforeunload", close);
    };
  }, [sessions]);

  return { restored, quitting };
}
