import { Banner, Button, EmptyState, Select, Tabs } from "@xdev-asia/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { profileName, useProfiles } from "@/agents/profileStore";
import { toApiError, type Api, type BoardTask, type RepoView, type TaskDraft, type TaskFull, type TaskLink, type TaskStatus } from "@/api";
import { TasksView } from "@/components/TasksView";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import type { Sessions } from "@/workspace/sessions";
import { applyFilters, loadFilters, NO_FILTERS, saveFilters, type BoardFilters } from "./boardFilters";
import { moveTask, startTask, type StartRequest, type StartWhere } from "./boardModel";
import { BoardView, UnreadableBanner } from "./BoardView";
import { DecomposeDialog } from "./DecomposeDialog";
import { FilterBar } from "./FilterBar";
import { StartTaskDialog } from "./StartTaskDialog";
import { TaskEditor } from "./TaskEditor";
import { TaskList } from "./TaskList";
import { useBoard } from "./useBoard";
import { TrackerSections } from "@/tasks/trackers/TrackerSections";
import "@/styles/board.css";

export type BoardTab = "board" | "list" | "runs";

type HostApi = Api;

export interface BoardHostProps {
  api: HostApi;
  repos: RepoView[] | null;
  /** The path of the repo shown first. */
  defaultRepo?: string | null;
  initialTab?: BoardTab;
  /** The agent task the Agent runs tab opens on. */
  initialRun?: string;
  /** A file task to open in the editor at once. */
  initialTask?: string;
  /** Open the split-a-goal dialog at once. */
  initialDecompose?: boolean;
  sessions?: Sessions | null;
  /** The worktree on screen, for "Current worktree". */
  current?: { path: string; branch: string | null } | null;
  /** Opens the agent tab; resolves with it, or null when it is not open yet. */
  onStart(req: StartRequest): Promise<{ tabId: string; tabTitle: string } | null>;
  /** Shows the tab of a link. */
  onOpenTab?(link: TaskLink): void;
  /** Lane task-decompose passes it; without it the button is not shown. */
  onDecompose?(): void;
}

/** What the shell gives the Tasks app besides the api. */
export type BoardWiring = Pick<BoardHostProps, "repos" | "defaultRepo" | "sessions" | "current" | "onStart" | "onOpenTab" | "onDecompose">;

type Editing = { kind: "edit"; full: TaskFull } | { kind: "new"; draft: TaskDraft };

function usableRepos(repos: RepoView[] | null): RepoView[] {
  return (repos ?? []).filter((r) => !r.missing);
}

/** The Tasks app: Board, List and Agent runs, with one repo and one set of filters for the first two. */
export function BoardHost(props: BoardHostProps): JSX.Element {
  const { t } = useI18n();
  const list = usableRepos(props.repos);
  const first = list.find((r) => r.path === props.defaultRepo) ?? list[0];
  const [repoPath, setRepoPath] = useState(first?.path ?? "");
  const [tab, setTab] = useState<BoardTab>(props.initialTab ?? "board");
  const repo = list.find((r) => r.path === repoPath) ?? first;
  // Read once: a repo switch remounts RepoBoard and must not reopen the dialog.
  const decompose = useRef(!!props.initialDecompose);

  return (
    <div className="board-host">
      <div className="board-host-bar">
        <Tabs
          label={t("board.tabs")}
          idPrefix="board"
          value={tab}
          onChange={(id) => setTab(id as BoardTab)}
          items={[
            { id: "board", label: t("board.tab.board") },
            { id: "list", label: t("board.tab.list") },
            { id: "runs", label: t("board.tab.runs") },
          ]}
        />
        {list.length > 1 && tab !== "runs" ? (
          <label className="board-host-repo">
            <Select
              name="board.repo"
              aria-label={t("board.repo")}
              value={repo?.path ?? ""}
              onChange={(e) => setRepoPath(e.target.value)}
              options={list.map((r) => ({ value: r.path, label: r.shortName }))}
            />
          </label>
        ) : null}
      </div>
      {tab === "runs" ? (
        <div className="board-panel" role="tabpanel" id="board-panel-runs" aria-labelledby="board-tab-runs">
          <TasksView api={props.api} initial={props.initialRun} defaultRepo={props.defaultRepo} />
        </div>
      ) : repo ? (
        <RepoBoard key={repo.path} {...props} repo={repo} tab={tab} decompose={decompose} />
      ) : (
        <EmptyState size="center" title={t("board.err.noRepo")} />
      )}
    </div>
  );
}

function RepoBoard(props: BoardHostProps & { repo: RepoView; tab: "board" | "list"; decompose: { current: boolean } }): JSX.Element {
  const { api, repo, tab } = props;
  const { t } = useI18n();
  const { view } = useProfiles();
  const board = useBoard(api, repo);
  const [filters, setFilters] = useState<BoardFilters>(() => loadFilters(repo.path));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [starting, setStarting] = useState<BoardTask | null>(null);
  const [deciding, setDeciding] = useState(() => {
    const first = props.decompose.current;
    props.decompose.current = false;
    return first;
  });
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [, setTick] = useState(0);
  const seen = useRef<string | undefined>(undefined);

  useEffect(() => saveFilters(repo.path, filters), [repo.path, filters]);

  // A tab that opens or closes changes what a card can offer.
  const sessions = props.sessions ?? null;
  useEffect(() => sessions?.subscribe(() => setTick((n) => n + 1)), [sessions]);

  const agentName = (id: string): string => profileName(view, id, t);
  const shown = useMemo(() => applyFilters(board.tasks, filters), [board.tasks, filters]);
  const clear = (): void => setFilters(NO_FILTERS);

  async function open(task: BoardTask): Promise<void> {
    try {
      setEditing({ kind: "edit", full: await api.boardGet(repo.path, task.id) });
    } catch (e) {
      pushToast({ id: "board-open-failed", text: t(`error.${toApiError(e).code}`) });
    }
  }

  // A task asked for from outside (the palette) opens once, after the first read has it.
  useEffect(() => {
    const id = props.initialTask;
    if (!id || seen.current === id || board.loading) return;
    seen.current = id;
    const task = board.tasks.find((x) => x.id === id);
    if (task) void open(task);
    // `open` only reads state set here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initialTask, board.loading]);

  async function move(task: BoardTask, to: TaskStatus): Promise<void> {
    board.setTasks(moveTask(board.tasks, task.id, to));
    try {
      await api.boardUpdate(repo.path, task.id, { status: to }, task.updated);
    } catch (e) {
      if (toApiError(e).code === "board_conflict") setConflict(true);
      else pushToast({ id: "board-move-failed", text: t("board.err.move") });
    }
    await board.reload();
  }

  const agents = (view?.profiles ?? []).filter((p) => p.profile.enabled && p.installed).map((p) => ({ value: p.profile.id, label: p.profile.name }));

  async function start(task: BoardTask, where: StartWhere, agent: string | null): Promise<void> {
    setBusy(true);
    try {
      await startTask(
        {
          worktreeCreate: (id, name, from, request) => api.worktreeCreate(id, name, from, request),
          worktreeDetails: (path, patch) => api.worktreeDetails(path, patch),
          boardLinkSet: (r, id, link) => api.boardLinkSet(r, id, link),
          boardUpdate: (r, id, patch, expected) => api.boardUpdate(r, id, patch, expected),
          onStart: props.onStart,
          current: props.current ?? null,
        },
        repo,
        task,
        where,
        agent,
      );
      setStarting(null);
    } catch (e) {
      pushToast({ id: "board-start-failed", text: `${t("board.start.failed")} ${t(`error.${toApiError(e).code}`)}` });
    } finally {
      setBusy(false);
      await board.reload();
    }
  }

  const tabOpen = (l: TaskLink): boolean => sessions?.tab(l.tabId) != null;
  const newTask = (status: TaskStatus): void => setEditing({ kind: "new", draft: { title: "", status, labels: [], body: "" } });

  return (
    <div className="board-panel" role="tabpanel" id={`board-panel-${tab}`} aria-labelledby={`board-tab-${tab}`}>
      {board.error ? <Banner title={t("board.err.load")} action={<Button variant="secondary" onClick={() => void board.reload()}>{t("board.err.reload")}</Button>} /> : null}
      {conflict ? (
        <Banner
          title={t("board.err.conflict")}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setConflict(false);
                void board.reload();
              }}
            >
              {t("board.err.reload")}
            </Button>
          }
        />
      ) : null}
      {board.tasks.length > 0 ? <FilterBar tasks={board.tasks} filters={filters} agentName={agentName} onChange={setFilters} /> : null}
      {tab === "board" ? (
        <BoardView
          tasks={shown}
          total={board.tasks.length}
          unreadable={board.unreadable}
          links={board.links}
          tabOpen={tabOpen}
          agentName={agentName}
          onOpen={(x) => void open(x)}
          onNew={newTask}
          onStart={setStarting}
          onMove={(x, to) => void move(x, to)}
          onOpenTab={(l) => props.onOpenTab?.(l)}
          onClearFilters={clear}
          onDecompose={props.onDecompose ?? (() => setDeciding(true))}
        />
      ) : (
        <>
          <UnreadableBanner items={board.unreadable} />
          <TaskList tasks={shown} total={board.tasks.length} agentName={agentName} onOpen={(x) => void open(x)} onNew={() => newTask("backlog")} onClearFilters={clear} />
          <TrackerSections api={api} repo={repo} agents={agents} current={props.current ?? null} onStart={props.onStart} />
        </>
      )}
      {editing ? (
        <TaskEditor
          key={editing.kind === "edit" ? editing.full.task.id : "new"}
          api={api}
          repo={repo.path}
          open
          task={editing.kind === "edit" ? editing.full : undefined}
          draft={editing.kind === "new" ? editing.draft : undefined}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            pushToast({ id: "board-saved", text: t("board.saved") });
            void board.reload();
          }}
        />
      ) : null}
      {deciding ? (
        <DecomposeDialog
          api={api}
          repo={repo.path}
          onClose={() => setDeciding(false)}
          onWritten={() => {
            setDeciding(false);
            pushToast({ id: "board-saved", text: t("board.saved") });
            void board.reload();
          }}
        />
      ) : null}
      {starting ? (
        <StartTaskDialog
          task={starting}
          agents={agents}
          defaultAgent={starting.assignee ?? view?.resolvedDefault ?? null}
          hasCurrent={!!props.current}
          busy={busy}
          onStart={(where, agent) => void start(starting, where, agent)}
          onClose={() => setStarting(null)}
        />
      ) : null}
    </div>
  );
}
