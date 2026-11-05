import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { api, type PtyProfile, type SessionRow, type SessionScope, type SkippedLogs } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { copyText } from "@/ui/clipboard";
import type { Sessions, Tab } from "@/workspace/sessions";
import { pushToast } from "@/workspace/toastStore";
import { HandOffDialog, type HandOffChoice } from "./HandOffDialog";
import { SessionsPanel, type ScopeKind } from "./SessionsPanel";
import { confirmResume, startResume, type PendingResume } from "./resumeFlow";
import { FIRST_PROMPT_MAX, handoffPrompt, transcriptText, TRANSCRIPT_MAX } from "./handoff";
import type { ResumeDestination } from "./resumeTarget";
import { baseName } from "./sessionsView";
import type { AgentSessionsStore } from "./store";

/** The worktree on screen, which the first two scopes and a resume from another folder lean on. */
export type Current = { path: string; repo: string | null };

/** The panel wired to the shared store and the tab store; the shell only says where a tab opened. */
export function SessionsSidebar(props: {
  store: AgentSessionsStore;
  sessions: Sessions;
  current: Current | null;
  /** The sidebar shows this view now: it reads the logs while it does. */
  visible: boolean;
  focusSeq?: number;
  reveal?: { key: string; seq: number } | null;
  /** A resume opened this tab; the shell brings its worktree up and puts it in front. */
  onOpened(tab: Tab): void;
  /** Bring an open tab forward. */
  onFocusTab(id: string): void;
  /** Select a worktree by path. */
  onGoTo(worktree: string): void;
}): JSX.Element {
  const { store, sessions, current, visible } = props;
  const { t } = useI18n();
  const state = useSyncExternalStore(store.subscribe, () => store.state, () => store.state);
  // A string, so an unchanged tab store reads as the same snapshot.
  const resumedKey = useSyncExternalStore(
    (listener) => sessions.subscribe(listener),
    () =>
      sessions
        .resumed()
        .map((tab) => `${tab.resumeOf}=${tab.id}`)
        .join("|"),
    () => "",
  );
  const open = useMemo(() => new Map(resumedKey === "" ? [] : resumedKey.split("|").map((p) => p.split("=") as [string, string])), [resumedKey]);
  const view = useSyncExternalStore(store.subscribe, () => store.view, () => store.view);
  const [handingOff, setHandingOff] = useState<{ row: SessionRow; source: string } | null>(null);
  const [asking, setAsking] = useState<PendingResume | null>(null);
  const [deleting, setDeleting] = useState<SessionRow | null>(null);
  const [skipped, setSkipped] = useState<SkippedLogs>({ count: 0, paths: [] });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    return store.watch();
  }, [store, visible]);
  // What the last scan skipped is asked for once a read has ended.
  useEffect(() => {
    if (!visible || state.loading) return;
    let live = true;
    api.agentSessionsSkipped().then(
      (found) => live && setSkipped(found),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [visible, state.loading]);
  // Relative times move on with the clock, not only with a read.
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [visible]);

  // The scope follows the worktree on screen while it is one of the two that name a folder.
  const scope = state.query.scope;
  const path = current?.path ?? null;
  const repo = current?.repo ?? null;
  useEffect(() => {
    const next = scopeFor(scope.kind, path, repo);
    if (next.kind !== scope.kind || (next.kind !== "all" && scope.kind !== "all" && next.path !== scope.path)) void store.setQuery({ scope: next });
  }, [store, scope, path, repo]);

  const resume = (row: SessionRow, dest?: ResumeDestination) => {
    const tab = startResume(sessions, row, path, setAsking, dest);
    if (tab) props.onOpened(tab);
  };

  const agentName = (agent: string) => t(`agentSessions.agent.${agent}`);
  // Opens the chosen agent with the session's first prompt as its own; a stored session has no terminal text to carry.
  const handOff = async (pending: { row: SessionRow; source: string }, choice: HandOffChoice) => {
    const s = pending.row.session;
    const title = s.title?.trim();
    let transcript: string | undefined;
    if (choice.content === "full") {
      try {
        transcript = transcriptText(await api.agentSessionTail(s.key, 200, TRANSCRIPT_MAX), TRANSCRIPT_MAX);
      } catch {
        pushToast({ text: t("agentSessions.handOff.fullFailed") });
      }
    }
    const text = handoffPrompt({
      fromProfile: agentName(s.agent),
      worktree: pending.source,
      branch: s.branch,
      firstPrompt: title ? Array.from(title).slice(0, FIRST_PROMPT_MAX).join("") : null,
      lines: [],
      transcript,
    });
    props.onOpened(sessions.open(choice.worktree, choice.profileId as PtyProfile, null, undefined, { prompt: text }));
    pushToast({ text: t("agentFork.handedOff") });
  };
  const handOffPaths = handingOff ? [...new Set([handingOff.source, path].filter((p): p is string => !!p))] : [];

  return (
    <>
      <SessionsPanel
        state={state}
        now={now}
        canScope={{ worktree: path !== null, repo: repo !== null }}
        openTab={(row) => open.get(row.session.id) ?? null}
        focusSeq={props.focusSeq}
        reveal={props.reveal}
        onSearch={(text) => store.search(text)}
        onScope={(kind) => void store.setQuery({ scope: scopeFor(kind, path, repo) })}
        onSort={(sort) => void store.setQuery({ sort })}
        onAgent={(agent) => void store.setQuery({ agent })}
        onHome={(homeId) => void store.setQuery({ homeId })}
        onMore={() => void store.loadMore()}
        onPrimary={(row, tab) => (tab ? props.onFocusTab(tab) : resume(row))}
        onCopyId={(row) => void navigator.clipboard?.writeText(row.session.id).catch(() => {})}
        onGoTo={(row) => row.worktree && props.onGoTo(row.worktree)}
        view={view}
        onView={(patch) => store.setView(patch)}
        onHandOff={(row) => {
          const source = row.worktree ?? path;
          if (source) setHandingOff({ row, source });
        }}
        current={path}
        onResumeAt={resume}
        onCopyFirstPrompt={(text) => void copyText(text).then((ok) => pushToast({ text: t(ok ? "agentSessions.firstPromptCopied" : "agentSessions.copyFailed") }))}
        loadTail={(row) => api.agentSessionTail(row.session.key)}
        onViewLog={(row) => void api.agentSessionOpenLog(row.session.key).catch(() => pushToast({ text: t("agentSessions.logFailed") }))}
        onCopyLogPath={(row) =>
          void api
            .agentSessionLogPath(row.session.key)
            .then((p) => copyText(p))
            .catch(() => false)
            .then((ok) => pushToast({ text: t(ok ? "agentSessions.logPathCopied" : "agentSessions.copyFailed") }))
        }
        onRevealLog={(row) => void api.agentSessionRevealLog(row.session.key).catch(() => pushToast({ text: t("agentSessions.logFailed") }))}
        onDelete={setDeleting}
        skipped={skipped}
        onCopyCommand={(command) => void copyText(command).then((ok) => pushToast({ text: t(ok ? "agentSessions.commandCopied" : "agentSessions.copyFailed") }))}
      />
      {handingOff && (
        <HandOffDialog
          profiles={(["claude", "codex"] as const).map((id) => ({ value: id, label: agentName(id) }))}
          worktrees={handOffPaths.map((p) => ({ value: p, label: baseName(p) || p }))}
          sourceProfile={handingOff.row.session.agent}
          sourceWorktree={handingOff.source}
          contentChoice
          onConfirm={(choice) => {
            void handOff(handingOff, choice);
            setHandingOff(null);
          }}
          onCancel={() => setHandingOff(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("agentSessions.delete.title")}
        body={t("agentSessions.delete.body", { title: deleting?.session.title ?? t("agentSessions.untitled") })}
        warning={t("agentSessions.delete.warning")}
        confirmLabel={t("agentSessions.delete.confirm")}
        onConfirm={() => {
          const row = deleting;
          setDeleting(null);
          if (!row) return;
          void api.agentSessionDelete(row.session.key).then(
            () => {
              pushToast({ text: t("agentSessions.deleted") });
              return store.refresh();
            },
            () => pushToast({ text: t("agentSessions.deleteFailed") }),
          );
        }}
        onCancel={() => setDeleting(null)}
      />
      <ConfirmDialog
        open={asking !== null}
        title={t("agentSessions.mismatch.title")}
        body={
          asking
            ? t("agentSessions.mismatch.body", { folder: asking.row.session.cwd ?? "?", target: baseName(asking.worktree) })
            : ""
        }
        confirmLabel={t("agentSessions.mismatch.confirm")}
        onConfirm={() => {
          if (asking) props.onOpened(confirmResume(sessions, asking));
          setAsking(null);
        }}
        onCancel={() => setAsking(null)}
      />
    </>
  );
}

/** The scope a switch picks; the two folder scopes fall back to All with no worktree on screen. */
export function scopeFor(kind: ScopeKind, path: string | null, repo: string | null): SessionScope {
  if (kind === "worktree" && path) return { kind, path };
  if (kind === "repo" && repo) return { kind, path: repo };
  return { kind: "all" };
}
