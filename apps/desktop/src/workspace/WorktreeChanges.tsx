import { Button } from "@xdev/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type GitSettings, type WorktreeChange, type WorktreeView } from "@/api";
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
  // The shared store of pull requests; the ship bar shows only when it is given.
  prs?: PrStore;
}): JSX.Element {
  const { api, worktree, sessions } = props;
  const { t } = useI18n();
  const [changes, setChanges] = useState<WorktreeChange[] | null>(null);
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
  // The load still running, if any; a focus does not start another.
  const running = useRef(0);
  const onCount = useRef(props.onCount);
  onCount.current = props.onCount;
  const onChanges = useRef(props.onChanges);
  onChanges.current = props.onChanges;
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
      const list = await api.worktreeChanges(path);
      if (seq !== loads.current) return;
      setChanges(list);
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
    return () => {
      window.removeEventListener("focus", again);
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

  if (primary) return <p className="ws-empty">{t("workspace.changes.primary")}</p>;

  const checked = (changes ?? []).filter((c) => !skipped.includes(c.path));
  const blocked = busy || message.trim() === "" || (!amend && checked.length === 0);

  function toggle(file: string): void {
    setSkipped((s) => (s.includes(file) ? s.filter((p) => p !== file) : [...s, file]));
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

  return (
    <div className="ws-changes">
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
        />
      )}
      {loadProblem && <ProblemNote problem={loadProblem} />}
      {problem && problem.code !== "hook_failed" && <ProblemNote problem={problem} />}
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
      {changes && changes.length > 0 && (
        <ul className="ws-change-list">
          {changes.map((c) => {
            const s = stats[c.path];
            return (
              <li key={c.path} className="ws-change">
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
              </li>
            );
          })}
        </ul>
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
    </div>
  );
}
