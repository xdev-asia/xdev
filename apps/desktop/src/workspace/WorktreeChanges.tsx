import { Button, Icon, MenuButton, pathRows, Tag, type TreeRow } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import { onChangesTouched, touchChanges } from "./changesBus";
import type { JSX } from "react";
import { toApiError, type Api, type ConflictEntry, type ConflictResolution, type ConflictState, type GitSettings, type StageState, type WorktreeChange, type WorktreeView } from "@/api";
import type { Problem } from "@/changes/useChanges";
import { ProblemNote } from "@/components/ChangesPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { diffStats } from "@/components/DiffView";
import { useI18n } from "@/i18n";
import { DEFAULT_GIT_SETTINGS } from "@/settings/gitDefaults";
import { conflictHintKey, conflictKindKey, conflictTitleKey, conflictVars, operationText, resolutionKey, resolutionsOf } from "./conflictModel";
import type { PrStore } from "./prs";
import type { Sessions } from "./sessions";
import { HistoryPanel } from "./HistoryPanel";
import { ShipBar } from "./ShipBar";
import type { TabStatus } from "./status";

// Git's own letters, so they read the same in every language.
const LETTER: Record<WorktreeChange["kind"], string> = { added: "A", modified: "M", deleted: "D" };

/** What the command palette can ask of the list. */
export type ChangesHandlers = { stageAll(): void; discardAll(): void };

type Stats = { added: number; removed: number };

type TreeKeyEvent = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: unknown; currentTarget: unknown; preventDefault(): void };

// Where a row sits in the tree view: its tree attributes, its name, and its arrow-key handler.
type Placed = { attrs: Record<string, unknown>; name: string; nav(e: TreeKeyEvent): boolean };

// A resolution refused because the row no longer matches git; the text names the file and says to refresh.
const STALE_CODES = new Set(["conflict_gone", "conflict_changed", "not_a_conflict"]);

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
  // Gives the agent the conflicts of the operation in progress (the recipe's variables); the button
  // is hidden without it.
  onResolveConflicts?(vars: Record<string, string>): void;
  // Opens Settings → Git; offered with a draft's agent problem.
  onOpenGitSettings?(): void;
  // Opens a commit's changes in a tab: one file, or all of them when `file` is null.
  onOpenCommit?(id: string, file: string | null): void;
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
  // The merge, rebase, cherry-pick or revert in progress; null when there is none.
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [askAbort, setAskAbort] = useState(false);
  // The conflicted file a Keep deletion dialog is about; null while it is closed.
  const [deleting, setDeleting] = useState<ConflictEntry | null>(null);
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
  // The base ref the ship bar compares against; a change reloads the history graph.
  const [base, setBase] = useState<string | undefined>(undefined);
  // Settings → Git, read with the list so a change there shows on the next focus.
  const [git, setGit] = useState<GitSettings>(DEFAULT_GIT_SETTINGS);
  // Folders closed in the tree view, as `<group>:<folder id>`.
  const [closedDirs, setClosedDirs] = useState<string[]>([]);
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
      const [list, state, open] = await Promise.all([
        api.worktreeChanges(path),
        api.worktreeStageState(path).catch(() => null),
        api.worktreeConflicts(path).catch(() => null),
      ]);
      if (seq !== loads.current) return;
      setChanges(list);
      setStates(state);
      setConflict(open);
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

  // The unmerged files, as rows: the change list has them when git reports them, else they are made up.
  const unmerged = conflict?.files ?? [];
  // What each side did to an unmerged file; a submodule conflict has no entry and is staged as before.
  const entryOf = (file: string) => conflict?.entries.find((e) => e.path === file);
  const conflictList: WorktreeChange[] = unmerged.map((file) => (changes ?? []).find((c) => c.path === file) ?? { path: file, kind: "modified" });
  const checked = (changes ?? []).filter((c) => !skipped.includes(c.path) && !unmerged.includes(c.path));
  const blocked = busy || message.trim() === "" || (!amend && checked.length === 0);

  function toggle(file: string): void {
    setSkipped((s) => (s.includes(file) ? s.filter((p) => p !== file) : [...s, file]));
  }

  const stateOf = (file: string) => states?.find((s) => s.path === file);
  // Any agent mid-turn, waiting on the person included: the worktree dot shows only the most
  // urgent status, so a finished agent would hide a working one.
  const agentBusy = sessions?.tabs(path).some((tab) => tab.agent && (tab.status === "working" || tab.status === "needs-you")) ?? false;
  // A file with both an index and a disk change is in both groups, as in git.
  const stagedList = (changes ?? []).filter((c) => !unmerged.includes(c.path) && stateOf(c.path)?.staged);
  const changedList = (changes ?? []).filter((c) => {
    if (unmerged.includes(c.path)) return false;
    const s = stateOf(c.path);
    return !s || s.unstaged || s.untracked || !s.staged;
  });

  const tree = git.sourceControlViewMode === "tree";

  // Flips the view and saves it in Settings > Git; the list changes at once and a failed save is reported.
  async function flipView(): Promise<void> {
    const next = tree ? "list" : "tree";
    const before = git;
    setGit({ ...git, sourceControlViewMode: next });
    try {
      setGit(await api.setGitSettings({ ...git, sourceControlViewMode: next }));
    } catch (e) {
      setGit(before);
      setProblem(toApiError(e));
    }
  }

  function toggleDir(group: string, id: string): void {
    const key = `${group}:${id}`;
    setClosedDirs((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));
  }

  // Arrow keys move between the rows of the tree; Left and Right close and open a folder, or step to the parent
  // and the first child. Only on the row itself: keys typed into a control inside it are its own.
  function treeNav(e: TreeKeyEvent, rows: TreeRow[], index: number, group: string): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target !== e.currentTarget) return false;
    const row = rows[index];
    const items = (e.currentTarget as HTMLElement).parentElement?.children;
    const focus = (i: number) => (items?.[i] as HTMLElement | undefined)?.focus();
    let handled = true;
    if (e.key === "ArrowDown") focus(Math.min(index + 1, rows.length - 1));
    else if (e.key === "ArrowUp") focus(Math.max(index - 1, 0));
    else if (e.key === "Home") focus(0);
    else if (e.key === "End") focus(rows.length - 1);
    else if (e.key === "ArrowRight" && row.kind === "dir") {
      if (!row.open) toggleDir(group, row.id);
      else if (rows[index + 1] && rows[index + 1].depth > row.depth) focus(index + 1);
    } else if (e.key === "ArrowLeft") {
      if (row.kind === "dir" && row.open) toggleDir(group, row.id);
      else {
        for (let i = index - 1; i >= 0; i--) {
          if (rows[i].depth < row.depth) {
            focus(i);
            break;
          }
        }
      }
    } else handled = false;
    if (handled) e.preventDefault();
    return handled;
  }

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
    group: "staged" | "changes" | "conflicts",
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
    const entry = group === "conflicts" ? entryOf(file) : undefined;
    const keep = entry && resolutionsOf(entry).find((how) => how !== "keep_deletion");
    if (e.key === "s" && entry) {
      if (keep) void resolveConflict(entry, keep);
    } else if (e.key === "s" && (group === "changes" || group === "conflicts")) void restage([file], true);
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

  // Settles one conflicted file; Rust reads it again first, so a stale row is refused and the list reads again.
  async function resolveConflict(entry: ConflictEntry, how: ConflictResolution, confirmed = false): Promise<void> {
    if (acting) return;
    setActing(true);
    setProblem(null);
    try {
      await api.worktreeConflictResolve(path, entry.path, entry.kind, how, confirmed);
    } catch (e) {
      const error = toApiError(e);
      if (error.code !== "needs_approval") setProblem(error);
    }
    touchChanges(path, touched.current);
    try {
      await load();
    } finally {
      setActing(false);
    }
  }

  // The dialog is the approval, as for a discard.
  function confirmDeletion(): void {
    const entry = deleting;
    setDeleting(null);
    if (entry) void resolveConflict(entry, "keep_deletion", true);
  }

  // Finishes the operation; a rebase that meets the next conflict shows it on the next read.
  async function continueOperation(): Promise<void> {
    if (acting) return;
    setActing(true);
    setProblem(null);
    try {
      await api.worktreeConflictContinue(path);
      props.onShipChanged?.();
      setShipKey((k) => k + 1);
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

  // The dialog is the approval, as for a discard.
  async function abortOperation(): Promise<void> {
    setAskAbort(false);
    setActing(true);
    setProblem(null);
    try {
      await api.worktreeConflictAbort(path, true);
      props.onShipChanged?.();
      setShipKey((k) => k + 1);
    } catch (e) {
      const error = toApiError(e);
      if (error.code !== "needs_approval") setProblem(error);
    }
    touchChanges(path, touched.current);
    try {
      await load();
    } finally {
      setActing(false);
    }
  }

  async function commit(confirmed = false): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    setAskPushed(false);
    try {
      const files = checked.map((c) => c.path);
      const sha = amend ? await api.worktreeAmend(path, files, message, confirmed) : await api.worktreeCommit(path, files, message);
      // Null: none of the files had changes any more, so the message waits for the next try.
      const made = Boolean(sha);
      if (sha) {
        setMessage("");
        setAmend(false);
        props.onShipChanged?.();
        setShipKey((k) => k + 1);
      }
      await load();
      return made;
    } catch (e) {
      const error = toApiError(e);
      if (amend && error.code === "amend_pushed") setAskPushed(true);
      else setProblem(error);
      return false;
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

  // A conflicted file with its kind, its hint and the resolutions it offers; they wrap below the path when narrow.
  function conflictRow(c: WorktreeChange, entry: ConflictEntry, at?: Placed): JSX.Element {
    return (
      <li
        key={c.path}
        className="ws-change ws-conflict-row"
        tabIndex={0}
        {...at?.attrs}
        onKeyDown={(e) => {
          if (!at?.nav(e)) rowKey(e, c.path, "conflicts");
        }}
      >
        <button type="button" className="ws-change-open" title={c.path} onClick={() => void open(c.path)}>
          <span className="ws-change-path ws-mono">{at ? at.name : c.path}</span>
        </button>
        <span className="ws-conflict-meta">
          <Tag tone="warn">{t(conflictKindKey(entry.kind))}</Tag>
          <span className="ws-conflict-hint">{t(conflictHintKey(entry.kind))}</span>
        </span>
        <span className="ws-conflict-resolve">
          {resolutionsOf(entry).map((how) => (
            <button
              key={how}
              type="button"
              className="btn-secondary"
              data-danger={how === "keep_deletion" ? "" : undefined}
              aria-label={t("conflicts.resolve.label", { action: t(resolutionKey(how)), path: c.path })}
              disabled={acting}
              onClick={() => (how === "keep_deletion" ? setDeleting(entry) : void resolveConflict(entry, how))}
            >
              {t(resolutionKey(how))}
            </button>
          ))}
        </span>
      </li>
    );
  }

  function list(files: WorktreeChange[], group: "staged" | "changes" | "conflicts"): JSX.Element {
    const closed = new Set(closedDirs.filter((k) => k.startsWith(`${group}:`)).map((k) => k.slice(group.length + 1)));
    const rows = tree ? pathRows(files.map((c) => ({ path: c.path, mark: c.kind })), closed, { compact: true }) : null;
    const byPath = new Map(files.map((c) => [c.path, c]));
    const place = (index: number): Placed | undefined => {
      const row = rows?.[index];
      if (!rows || !row) return undefined;
      return {
        name: row.name,
        nav: (e) => treeNav(e, rows, index, group),
        attrs: { role: "treeitem", "aria-level": row.depth + 1, style: { paddingLeft: 4 + row.depth * 14 } },
      };
    };
    const items = rows ? rows.map((row, i) => ({ row, at: place(i), c: byPath.get(row.id) })) : files.map((c) => ({ row: null, at: undefined, c }));
    return (
      <ul className="ws-change-list" role={tree ? "tree" : undefined} data-view={tree ? "tree" : "list"} aria-label={tree ? t(group === "staged" ? "changes.group.staged" : "changes.group.changes") : undefined}>
        {items.map(({ row, at, c }) => {
          if (row && row.kind === "dir" && at) {
            return (
              <li
                key={`dir:${row.id}`}
                className="ws-change ws-change-dir"
                tabIndex={0}
                {...at.attrs}
                aria-expanded={row.open}
                onKeyDown={(e) => {
                  if (!at.nav(e) && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    toggleDir(group, row.id);
                  }
                }}
              >
                <button type="button" className="ws-change-open" tabIndex={-1} onClick={() => toggleDir(group, row.id)}>
                  <span className="ws-change-caret" aria-hidden="true">{row.open ? "▾" : "▸"}</span>
                  <span className="ws-change-path ws-mono">{row.name}</span>
                  <span className="ws-change-group-count ws-mono">{row.count}</span>
                </button>
              </li>
            );
          }
          if (!c) return null;
          const entry = group === "conflicts" ? entryOf(c.path) : undefined;
          if (entry) return conflictRow(c, entry, at);
          const s = stats[c.path];
          return (
            <li
              key={c.path}
              className="ws-change"
              tabIndex={0}
              {...at?.attrs}
              onKeyDown={(e) => {
                if (!at?.nav(e)) rowKey(e, c.path, group);
              }}
            >
              {group !== "conflicts" && (
                <input
                  type="checkbox"
                  checked={!skipped.includes(c.path)}
                  aria-label={t("workspace.changes.include", { path: c.path })}
                  onChange={() => toggle(c.path)}
                />
              )}
              <button type="button" className="ws-change-open" title={c.path} onClick={() => void open(c.path)}>
                <span className="ws-change-kind ws-mono" data-kind={c.kind} title={t(`changes.kind.${c.kind}`)}>
                  {LETTER[c.kind]}
                </span>
                <span className="ws-change-path ws-mono">{at ? at.name : c.path}</span>
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
                  aria-label={group === "conflicts" ? t("conflicts.stage", { path: c.path }) : t(group === "staged" ? "changes.unstage" : "changes.stage", { path: c.path })}
                  title={group === "conflicts" ? t("conflicts.stage", { path: c.path }) : t(group === "staged" ? "changes.unstage" : "changes.stage", { path: c.path })}
                  disabled={acting}
                  onClick={() => void restage([c.path], group !== "staged")}
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

  const stagedSection = stagedList.length > 0 && (
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
  );
  const changesSection = changedList.length > 0 && (
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
  );
  return (
    <div className="ws-changes" ref={root}>
      <div className="ws-changes-head">
        <strong className="ws-changes-title">
          {changes && changes.length > 0 ? t("workspace.changes.title", { count: changes.length }) : changes && t("workspace.changes.none")}
        </strong>
        <button
          type="button"
          className="ws-change-act ws-change-view"
          data-view-toggle={tree ? "tree" : "list"}
          aria-label={tree ? t("changes.viewMode.toList") : t("changes.viewMode.toTree")}
          title={tree ? t("changes.viewMode.toList") : t("changes.viewMode.toTree")}
          onClick={() => void flipView()}
        >
          <Icon name={tree ? "list" : "folder"} size={14} />
        </button>
      </div>
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
          onBase={setBase}
          hasMessage={message.trim() !== ""}
          onCommitFirst={() => (blocked ? Promise.resolve(false) : commit())}
          onFixPush={props.onFixPush}
          onOpenGitSettings={props.onOpenGitSettings}
        />
      )}
      {loadProblem && <ProblemNote problem={loadProblem} />}
      {problem && problem.code !== "hook_failed" && !STALE_CODES.has(problem.code) && <ProblemNote problem={problem} onOpenSettings={props.onOpenGitSettings} />}
      {problem && STALE_CODES.has(problem.code) && (
        <div className="banner banner-warn" role="alert" data-stale="">
          <div className="banner-text">
            <span>{t(`error.${problem.code}`, { path: problem.detail ?? "" })}</span>
          </div>
        </div>
      )}
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
      {conflict && (
        <div className="ws-conflict-bar" data-conflict-bar="" role="group" aria-label={t("conflicts.bar")}>
          <span className="ws-conflict-op">{operationText(conflict, t)}</span>
          <span className="ws-conflict-actions">
            {props.onResolveConflicts && git.sourceControlAi && (
              <button
                type="button"
                className="btn-secondary"
                disabled={acting || unmerged.length === 0}
                onClick={() => props.onResolveConflicts?.(conflictVars(conflict, worktree.branch ?? ""))}
              >
                {t("conflicts.resolve")}
              </button>
            )}
            <button
              type="button"
              className="btn-secondary"
              disabled={acting || unmerged.length > 0}
              title={unmerged.length > 0 ? t("conflicts.continueHint") : undefined}
              onClick={() => void continueOperation()}
            >
              {t("conflicts.continue")}
            </button>
            <button type="button" className="btn-secondary" data-danger="" disabled={acting} onClick={() => setAskAbort(true)}>
              {t("conflicts.abort")}
            </button>
          </span>
        </div>
      )}
      {conflictList.length > 0 && (
        <section className="ws-change-group" data-group="conflicts" aria-label={t("conflicts.group", { count: conflictList.length })}>
          <header className="ws-change-head">
            <span className="ws-change-group-name">{t(conflictTitleKey(conflict?.op ?? "merge"))}</span>
            <span className="ws-change-group-count ws-mono">{conflictList.length}</span>
          </header>
          <p className="ws-conflict-note">{t("conflicts.note")}</p>
          {list(conflictList, "conflicts")}
        </section>
      )}
      {git.sourceControlGroupOrder === "staged-first" ? <>{stagedSection}{changesSection}</> : <>{changesSection}{stagedSection}</>}
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
      <div className="ws-commit-actions">
        {/* The panel's primary: a split button, Commit and its options. */}
        <span className="ws-commit-split">
          <Button variant="primary" type="button" disabled={blocked} onClick={() => void commit()}>
            {amend ? t("ship.amend.button") : t("workspace.changes.commit", { count: checked.length })}
          </Button>
          <MenuButton
            variant="icon"
            icon="chevron"
            align="end"
            label={t("workspace.changes.commitOptions")}
            items={[{ label: t("ship.amend.toggle"), checked: amend, disabled: busy, onSelect: () => setAmend((a) => !a) }]}
          />
        </span>
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
        open={askAbort}
        title={t("conflicts.abort.title", { operation: conflict ? operationText(conflict, t) : "" })}
        body={t("conflicts.abort.body")}
        confirmLabel={t("conflicts.abort.confirm")}
        onConfirm={() => void abortOperation()}
        onCancel={() => setAskAbort(false)}
      >
        <ul className="ws-conflict-files ws-mono">
          {unmerged.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting !== null}
        title={t("conflicts.resolve.confirmDeletion", { path: deleting?.path ?? "" })}
        body={t("conflicts.resolve.confirmDeletionBody")}
        warning={agentBusy ? t("changes.discard.agent") : undefined}
        confirmLabel={t("conflicts.resolve.keepDeletion")}
        onConfirm={confirmDeletion}
        onCancel={() => {
          setDeleting(null);
          focusList();
        }}
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
      <HistoryPanel api={api} worktree={path} base={base} reloadKey={shipKey} onOpenCommit={(id, file) => props.onOpenCommit?.(id, file)} />
    </div>
  );
}

