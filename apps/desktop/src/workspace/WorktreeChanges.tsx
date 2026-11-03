import { Button } from "@xdev/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type WorktreeChange, type WorktreeView } from "../api";
import type { Problem } from "../changes/useChanges";
import { ProblemNote } from "../components/ChangesPanel";
import { diffStats } from "../components/DiffView";
import { useI18n } from "../i18n";
import type { Sessions } from "./sessions";
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
  // Only the newest load may write, so a slow one never shows an older list.
  const loads = useRef(0);
  // The load still running, if any; a focus does not start another.
  const running = useRef(0);
  const onCount = useRef(props.onCount);
  onCount.current = props.onCount;
  const primary = worktree.start === null;
  const path = worktree.path;

  async function load(): Promise<void> {
    const seq = ++loads.current;
    running.current = seq;
    try {
      const list = await api.worktreeChanges(path);
      if (seq !== loads.current) return;
      setChanges(list);
      // Counts belong to the diffs read before; a file may have changed since.
      setStats({});
      setLoadProblem(null);
      onCount.current?.(list.length);
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
      if ([...now].some(([id, status]) => status === "idle" && before.get(id) === "working")) void load();
      before = now;
    });
  }, [api, path, primary, sessions]);

  if (primary) return <p className="ws-empty">{t("workspace.changes.primary")}</p>;

  const checked = (changes ?? []).filter((c) => !skipped.includes(c.path));
  const blocked = busy || checked.length === 0 || message.trim() === "";

  function toggle(file: string): void {
    setSkipped((s) => (s.includes(file) ? s.filter((p) => p !== file) : [...s, file]));
  }

  async function commit(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const sha = await api.worktreeCommit(
        path,
        checked.map((c) => c.path),
        message,
      );
      // Null: none of the files had changes any more, so the message waits for the next try.
      if (sha) setMessage("");
      await load();
    } catch (e) {
      setProblem(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-changes">
      <strong className="ws-changes-title">
        {changes && changes.length > 0 ? t("workspace.changes.title", { count: changes.length }) : changes && t("workspace.changes.none")}
      </strong>
      {loadProblem && <ProblemNote problem={loadProblem} />}
      {problem && <ProblemNote problem={problem} />}
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
        <textarea className="ws-mono" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <Button type="button" disabled={blocked} onClick={() => void commit()}>
        {t("workspace.changes.commit", { count: checked.length })}
      </Button>
    </div>
  );
}
