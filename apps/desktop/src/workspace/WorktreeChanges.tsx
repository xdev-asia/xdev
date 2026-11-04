import { Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import { onChangesTouched, touchChanges } from "./changesBus";
import type { JSX } from "react";
import { toApiError, type Api, type GitSettings, type StageState, type WorktreeChange, type WorktreeView } from "@/api";
import type { Problem } from "@/changes/useChanges";
import { ProblemNote } from "@/components/ChangesPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { diffStats } from "@/components/DiffView";
import { useI18n } from "@/i18n";
import { DEFAULT_GIT_SETTINGS } from "@/settings/gitDefaults";
import type { PrStore } from "./prs";
import type { Sessions } from "./sessions";
import { ShipBar } from "./ShipBar";
import type { TabStatus } from "./status";

// Git's own letters, so they read the same in every language.
const LETTER: Record<WorktreeChange["kind"], string> = { added: "A", modified: "M", deleted: "D" };

/** What the command palette can ask of the list. */
export type ChangesHandlers = { stageAll(): void; discardAll(): void };

type Stats = { added: number; removed: number };

/**
 * The uncommitted files of one worktree, and a commit of the ones left checked. Looks again when
 * the window gets focus, after a commit, and when one of the worktree's tabs stops working.
 */
export function WorktreeChanges(props: {
  api: Api;
  worktree: WorktreeView;
  sessions?: Sessions | null;
  onOpenFile(file: string): void;
  onCount?(count: number): void;
  // The whole list, each time it is read.
  onChanges?(list: WorktreeChange[]): void;
  // Hands a failed hook's output to an agent; the button is hidden without it.
  onFixWithAgent?(output: string): void;
  // After a commit or amend, so the ship bar reads again.
  onShipChanged?(): void;
  // The Fix button of a failed push: its output and the branch.
  onFixPush?(output: string, branch: string): void;
  // Opens Settings → Git; offered with a draft's agent problem.
  onOpenGitSettings?(): void;
  // The shared store of pull requests; the ship bar shows only when it is given.
  prs?: PrStore;
  // Gives the palette handlers for the list's bulk actions, and takes them back on unmount.
  register?(handlers: ChangesHandlers | null): void;
}): JSX.Element {
  const { api, worktree, sessions } = props;
  const { t } = useI18n();
  const [changes, setChanges] = useState<WorktreeChange[] | null>(null);
  // Where each path stands against the index; null until read, or when it could not be.
  const [states, setStates] = useState<StageState[] | null>(null);
  // A group action (stage, unstage) is running.
  const [acting, setActing] = useState(false);
  // The files a discard dialog is about; null while it is closed.
  const [discarding, setDiscarding] = useState<string[] | null>(null);
  const [alsoStaged, setAlsoStaged] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<Record<string, Stats>>({});
  // Unchecked paths, so a file that shows up later starts checked.
  const [skipped, setSkipped] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  // Kept apart: a good load clears its own error, never the commit's.
  const [loadProblem, setLoadProblem] = useState<Problem | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [amend, setAmend] = useState(false);
  // The last amend was refused because the commit is pushed; waits for the person's answer.
  const [askPushed, setAskPushed] = useState(false);
  // Bumped when the branch may have moved, so the ship bar reads again.
  const [shipKey, setShipKey] = useState(0);
  // Settings → Git, read with the list so a change there shows on the next focus.
  const [git, setGit] = useState<GitSettings>(DEFAULT_GIT_SETTINGS);
  const field = useRef<HTMLTextAreaElement>(null);
  // Only the newest load may write, so a slow one never shows an older list.
  const loads = useRef(0);
  // This panel's own listener on the changes bus, so it does not read twice after its own action.
  const touched = useRef<(() => void) | undefined>(undefined);
  // The load still running, if any; a focus does not start another.
  const running = useRef(0);
  const onCount = useRef(props.onCount);
  onCount.current = props.onCount;
  const onChanges = useRef(props.onChanges);
  onChanges.current = props.onChanges;
  const register = useRef(props.register);
  register.current = props.register;
  // The newest closures, so a handler handed out once never acts on an old list.
  const latest = useRef<ChangesHandlers>({ stageAll() {}, discardAll() {} });
  const primary = worktree.start === null;
  const path = worktree.path;

  async function load(): Promise<void> {
    const seq = ++loads.current;
    running.current = seq;
    void api.gitSettings().then(
      (stored) => {
        if (seq === loads.current) setGit(stored);
      },
      () => undefined,
    );
    try {
      // The groups are only information: a failed stage state leaves one plain list.
      const [list, state] = await Promise.all([api.worktreeChanges(path), api.worktreeStageState(path).catch(() => null)]);
      if (seq !== loads.current) return;
      setChanges(list);
      setStates(state);
      // Counts belong to the diffs read before; a file may have changed since.
      setStats({});
      setLoadProblem(null);
      onCount.current?.(list.length);
      onChanges.current?.(list);
    } catch (e) {
      if (seq === loads.current) setLoadProblem(toApiError(e));
    } finally {
      if (running.current === seq) running.current = 0;
    }
  }

  // Reads one file's diff for its line counts; only files the user opens cost a read.
  async function open(file: string): Promise<void> {
    props.onOpenFile(file);
    const seq = loads.current;
    const diff = await api.worktreeFileDiff(path, file).catch(() => null);
    if (!diff || diff.skip || seq !== loads.current) return;
    const counted = diffStats(diff.old ?? "", diff.new ?? "");
    setStats((s) => ({ ...s, [file]: counted }));
  }

  useEffect(() => {
    if (primary) return;
    void load();
    const again = () => {
      if (!running.current) void load();
    };
    window.addEventListener("focus", again);
    // The review tab staged something.
    const onTouched = () => void load();
    touched.current = onTouched;
    const stop = onChangesTouched(path, onTouched);
    return () => {
      window.removeEventListener("focus", again);
      stop();
      // A load still running belongs to a worktree that is gone.
      loads.current++;
    };
  }, [api, path, primary]);

  // An agent that went quiet has likely written files.
  useEffect(() => {
    if (primary || !sessions) return;
    const statuses = () => new Map<string, TabStatus>(sessions.tabs(path).map((tab) => [tab.id, tab.status]));
    let before = statuses();
    return sessions.subscribe(() => {
      const now = statuses();
      if ([...now].some(([id, status]) => status === "idle" && before.get(id) === "working")) {
        void load();
        setShipKey((k) => k + 1);
      }
      before = now;
    });
  }, [api, path, primary, sessions]);

  useEffect(() => {
    if (primary) return;
    register.current?.({ stageAll: () => latest.current.stageAll(), discardAll: () => latest.current.discardAll() });
    return () => register.current?.(null);
  }, [path, primary]);

  if (primary) return <p className="ws-empty">{t("workspace.changes.primary")}</p>;

  const checked = (changes ?? []).filter((c) => !skipped.includes(c.path));
  const blocked = busy || message.trim() === "" || (!amend && checked.length === 0);

  function toggle(file: string): void {
    setSkipped((s) => (s.includes(file) ? s.filter((p) => p !== file) : [...s, file]));
  }

  const stateOf = (file: string) => states?.find((s) => s.path === file);
  // Any agent mid-turn, waiting on the person included: the worktree dot shows only the most
  // urgent status, so a finished agent would hide a working one.
  const agentBusy = sessions?.tabs(path).some((tab) => tab.agent && (tab.status === "working" || tab.status === "needs-you")) ?? false;
  // A file with both an index and a disk change is in both groups, as in git.
  const stagedList = (changes ?? []).filter((c) => stateOf(c.path)?.staged);
  const changedList = (changes ?? []).filter((c) => {
    const s = stateOf(c.path);
    return !s || s.unstaged || s.untracked || !s.staged;
  });

  // Runs a stage change, then reads again whatever happened.
  async function restage(files: string[], staged: boolean): Promise<void> {
    if (files.length === 0 || acting) return;
    setActing(true);
    setProblem(null);
    try {
      await api.worktreeStage(path, files, staged);
    } catch (e) {
      setProblem(toApiError(e));
    }
    touchChanges(path, touched.current);
    try {
      await load();
    } finally {
      setActing(false);
    }
  }

  latest.current = {
    stageAll: () => void restage(changedList.map((c) => c.path), true),
    discardAll: () => askDiscard(changedList.map((c) => c.path)),
  };

  // s, u and Delete act on the focused row, each only in the group where it makes sense.
  function rowKey(
    e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target?: unknown; preventDefault(): void },
    file: string,
    group: "staged" | "changes",
  ): void {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!blocked) void commit();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Keys typed into a control inside the row (the checkbox, or a field added later) are its own.
    const target = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
    if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName ?? ""))) return;
    if (e.key === "s" && group === "changes") void restage([file], true);
    else if (e.key === "u" && group === "staged") void restage([file], false);
    else if (e.key === "Delete" && group === "changes") askDiscard([file]);
    else return;
    e.preventDefault();
  }

  function askDiscard(files: string[]): void {
    if (files.length === 0) return;
    setAlsoStaged(false);
    setDiscarding(files);
  }

  // Back to the list once the dialog is gone; a closed dialog first gives focus to its opener.
  function focusList(): void {
    setTimeout(() => root.current?.querySelector<HTMLElement>(".ws-change")?.focus(), 0);
  }

  function cancelDiscard(): void {
    setDiscarding(null);
    focusList();
  }

  async function confirmDiscard(): Promise<void> {
    const files = discarding;
    if (!files) return;
    const staged = alsoStaged && files.some((f) => stateOf(f)?.staged);
    setDiscarding(null);
    setActing(true);
    setProblem(null);
    try {
      // The dialog is the approval.
      await api.worktreeDiscard(path, files, staged, true);
    } catch (e) {
      const error = toApiError(e);
      if (error.code !== "needs_approval") setProblem(error);
    }
    touchChanges(path, touched.current);
    try {
      await load();
    } finally {
      setActing(false);
      focusList();
    }
  }

  async function commit(confirmed = false): Promise<void> {
    setBusy(true);
    setProblem(null);
    setAskPushed(false);
    try {
      const files = checked.map((c) => c.path);
      const sha = amend ? await api.worktreeAmend(path, files, message, confirmed) : await api.worktreeCommit(path, files, message);
      // Null: none of the files had changes any more, so the message waits for the next try.
      if (sha) {
        setMessage("");
        setAmend(false);
        props.onShipChanged?.();
        setShipKey((k) => k + 1);
      }
      await load();
    } catch (e) {
      const error = toApiError(e);
      if (amend && error.code === "amend_pushed") setAskPushed(true);
      else setProblem(error);
    } finally {
      setBusy(false);
    }
  }

  // Only fills the box; the person reads it and commits.
  async function draft(): Promise<void> {
    setDrafting(true);
    setProblem(null);
    try {
      setMessage(await api.worktreeDraftCommit(path, checked.map((c) => c.path)));
    } catch (e) {
      setProblem(toApiError(e));
    } finally {
      setDrafting(false);
    }
  }

  function list(files: WorktreeChange[], group: "staged" | "changes"): JSX.Element {
    return (
      <ul className="ws-change-list">
        {files.map((c) => {
          const s = stats[c.path];
          return (
            <li key={c.path} className="ws-change" tabIndex={0} onKeyDown={(e) => rowKey(e, c.path, group)}>
              <input
                type="checkbox"
                checked={!skipped.includes(c.path)}
                aria-label={t("workspace.changes.include", { path: c.path })}
                onChange={() => toggle(c.path)}
              />
              <button type="button" className="ws-change-open" title={c.path} onClick={() => void open(c.path)}>
                <span className="ws-change-kind ws-mono" data-kind={c.kind} title={t(`changes.kind.${c.kind}`)}>
                  {LETTER[c.kind]}
                </span>
                <span className="ws-change-path ws-mono">{c.path}</span>
                {s && (
                  <span className="diff-stats ws-change-stats ws-mono">
                    <span className="diff-added" aria-hidden="true">+{s.added}</span>
                    <span className="diff-removed" aria-hidden="true">−{s.removed}</span>
                    <span className="diff-stats-text">{t("diff.stats", { count: s.added, removed: s.removed })}</span>
                  </span>
                )}
              </button>
              <span className="ws-change-actions">
                <button
                  type="button"
                  className="ws-change-act"
                  aria-label={t(group === "staged" ? "changes.unstage" : "changes.stage", { path: c.path })}
                  title={t(group === "staged" ? "changes.unstage" : "changes.stage", { path: c.path })}
                  disabled={acting}
                  onClick={() => void restage([c.path], group === "changes")}
                >
                  {group === "staged" ? "−" : "+"}
                </button>
                {group === "changes" && (
                  <button
                    type="button"
                    className="ws-change-act"
                    data-danger=""
                    aria-label={t("changes.discard", { path: c.path })}
                    title={t("changes.discard", { path: c.path })}
                    disabled={acting}
                    onClick={() => askDiscard([c.path])}
                  >
                    ×
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="ws-changes" ref={root}>
      <strong className="ws-changes-title">
        {changes && changes.length > 0 ? t("workspace.changes.title", { count: changes.length }) : changes && t("workspace.changes.none")}
      </strong>
      {props.prs && (
        <ShipBar
          api={api}
          worktree={path}
          checked={checked.length}
          prs={props.prs}
          refreshKey={shipKey}
          git={git}
          onCommit={() => (message.trim() === "" ? field.current?.focus() : blocked ? undefined : void commit())}
          onChanged={() => props.onShipChanged?.()}
          onFixPush={props.onFixPush}
          onOpenGitSettings={props.onOpenGitSettings}
        />
      )}
      {loadProblem && <ProblemNote problem={loadProblem} />}
      {problem && problem.code !== "hook_failed" && <ProblemNote problem={problem} onOpenSettings={props.onOpenGitSettings} />}
      {problem?.code === "hook_failed" && (
        <div className="ws-hook" role="alert">
          <span>{t("error.hook_failed")}</span>
          <pre className="ws-hook-output ws-mono" aria-label={t("ship.hook.output")}>{problem.detail ?? ""}</pre>
          <div className="ws-hook-actions">
            {props.onFixWithAgent && git.sourceControlAi && (
              <button type="button" className="btn-secondary" onClick={() => props.onFixWithAgent?.(problem.detail ?? "")}>
                {t("ship.hook.fix")}
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={() => void Promise.resolve(navigator.clipboard?.writeText(problem.detail ?? "")).catch(() => undefined)}>
              {t("ship.hook.copy")}
            </button>
          </div>
        </div>
      )}
      {stagedList.length > 0 && (
        <section className="ws-change-group" data-group="staged" aria-label={t("changes.group.staged")}>
          <header className="ws-change-head">
            <span className="ws-change-group-name">{t("changes.group.staged")}</span>
            <span className="ws-change-group-count ws-mono">{stagedList.length}</span>
            <span className="ws-change-group-actions">
              <button type="button" className="btn-secondary" aria-label={t("changes.unstageAll")} disabled={acting} onClick={() => void restage(stagedList.map((c) => c.path), false)}>
                {t("changes.unstageAll")}
              </button>
            </span>
          </header>
          {list(stagedList, "staged")}
        </section>
      )}
      {changedList.length > 0 && (
        <section className="ws-change-group" data-group="changes" aria-label={t("changes.group.changes")}>
          <header className="ws-change-head">
            <span className="ws-change-group-name">{t("changes.group.changes")}</span>
            <span className="ws-change-group-count ws-mono">{changedList.length}</span>
            <span className="ws-change-group-actions">
              <button type="button" className="btn-secondary" aria-label={t("changes.stageAll")} disabled={acting} onClick={() => void restage(changedList.map((c) => c.path), true)}>
                {t("changes.stageAll")}
              </button>
              <button type="button" className="btn-secondary" aria-label={t("changes.discardAll")} disabled={acting} onClick={() => askDiscard(changedList.map((c) => c.path))}>
                {t("changes.discardAll")}
              </button>
            </span>
          </header>
          {list(changedList, "changes")}
        </section>
      )}
      <label className="ws-commit-field">
        {t("workspace.changes.message")}
        <textarea
          ref={field}
          className="ws-mono"
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              if (!blocked) void commit();
            }
          }}
        />
      </label>
      <label className="ws-amend">
        <input type="checkbox" checked={amend} disabled={busy} onChange={() => setAmend((a) => !a)} />
        {t("ship.amend.toggle")}
      </label>
      <div className="ws-commit-actions">
        <Button type="button" disabled={blocked} onClick={() => void commit()}>
          {amend ? t("ship.amend.button") : t("workspace.changes.commit", { count: checked.length })}
        </Button>
        {git.sourceControlAi && (
          <button type="button" className="btn-secondary" disabled={drafting || busy || checked.length === 0} onClick={() => void draft()}>
            {drafting ? t("ship.drafting") : t("ship.draft")}
          </button>
        )}
      </div>
      <ConfirmDialog
        open={askPushed}
        title={t("ship.amend.pushed.title")}
        body={t("ship.amend.pushed.body")}
        confirmLabel={t("ship.amend.pushed.confirm")}
        onConfirm={() => void commit(true)}
        onCancel={() => setAskPushed(false)}
      />
      <ConfirmDialog
        open={discarding !== null}
        title={discarding && discarding.length === 1 ? t("changes.discard.title", { path: discarding[0] }) : t("changes.discard.titleMany", { count: discarding?.length ?? 0 })}
        body={t("changes.discard.body")}
        warning={agentBusy ? t("changes.discard.agent") : undefined}
        confirmLabel={t("changes.discard.confirm")}
        onConfirm={() => void confirmDiscard()}
        onCancel={cancelDiscard}
      >
        {discarding?.some((f) => stateOf(f)?.staged) && (
          <label className="dialog-option">
            <input type="checkbox" checked={alsoStaged} onChange={() => setAlsoStaged((v) => !v)} />
            {t("changes.discard.staged")}
          </label>
        )}
      </ConfirmDialog>
    </div>
  );
}
