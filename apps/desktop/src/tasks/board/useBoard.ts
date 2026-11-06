import { useCallback, useEffect, useRef, useState } from "react";
import { toApiError, type Api, type BoardList, type BoardTask, type FsChanged, type TaskLink } from "@/api";

type BoardApi = Pick<Api, "boardList" | "boardLinks" | "filesWatch" | "filesUnwatch">;

/** The folder that holds the task files, with its trailing slash. */
export const TASKS_DIR = ".xdev/tasks/";
/** How long changes are gathered before the board is read again. */
export const RELOAD_DELAY_MS = 200;
/** How often the board is read when no watcher delivers (the mock). */
export const POLL_MS = 5000;

/** Whether a batch of file events touches the task files; an overflow means anything may have. */
export function touchesTasks(e: FsChanged): boolean {
  return e.events.some((ev) => ev.kind === "overflow" || ev.rel.startsWith(TASKS_DIR));
}

export interface BoardState {
  tasks: BoardTask[];
  unreadable: BoardList["unreadable"];
  links: TaskLink[];
  /** True until the first read ends. */
  loading: boolean;
  /** The error code of the last read, or null. */
  error: string | null;
  reload(): Promise<void>;
  /** Shows `tasks` now, before the next read; a read replaces them. */
  setTasks(tasks: BoardTask[]): void;
}

/**
 * Reads a repo's tasks and links, and reads again when the files under `.xdev/tasks` change (debounced).
 * It stops watching when the view unmounts or the repo changes.
 */
export function useBoard(api: BoardApi, repo: { id: string; path: string }): BoardState {
  const [list, setList] = useState<BoardList>({ tasks: [], unreadable: [] });
  const [links, setLinks] = useState<TaskLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [next, nextLinks] = await Promise.all([api.boardList(repo.path), api.boardLinks(repo.path)]);
      if (mine !== seq.current) return;
      setList(next);
      setLinks(nextLinks);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(toApiError(e).code);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [api, repo.path]);

  useEffect(() => {
    setLoading(true);
    void reload();
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const startPolling = (): void => {
      if (live && poll === undefined) poll = setInterval(() => void reload(), POLL_MS);
    };
    const id = `board:${repo.id}`;
    // The mock never delivers board events, so it is polled, as is a repo that cannot be watched.
    if ("__boardEditOutside" in api) startPolling();
    api
      .filesWatch(repo.path, id, (e) => {
        if (!live || !touchesTasks(e)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void reload(), RELOAD_DELAY_MS);
      })
      .catch(startPolling);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(poll);
      void api.filesUnwatch(id).catch(() => {});
    };
  }, [api, repo.id, repo.path, reload]);

  const setTasks = useCallback((tasks: BoardTask[]) => setList((l) => ({ ...l, tasks })), []);
  return { tasks: list.tasks, unreadable: list.unreadable, links, loading, error, reload, setTasks };
}
