import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Api, RepoView, TaskDraft, WorktreeView } from "@/api";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { TaskEditor } from "./TaskEditor";

const listeners = new Set<(draft: TaskDraft | undefined) => void>();

/** Opens the task editor on the repo of the worktree on screen: blank, or from `draft`. */
export function openTaskEditor(draft?: TaskDraft): void {
  for (const fn of [...listeners]) fn(draft);
}

/** The path of the repo that owns `current`; null when none is open. */
export function repoOf(repos: readonly RepoView[] | null, current: WorktreeView | null): string | null {
  if (!current) return null;
  const repo = (repos ?? []).find((r) => !r.missing && r.worktrees.some((w) => w.path === current.path));
  return repo?.path ?? null;
}

/** Mount once in the workspace: shows the editor that `openTaskEditor` asks for. */
export function TaskEditorHost(props: { api: Api; repos: RepoView[] | null; current: WorktreeView | null }): JSX.Element | null {
  const { api } = props;
  const { t } = useI18n();
  const [req, setReq] = useState<{ repo: string; draft?: TaskDraft; seq: number } | null>(null);
  // The listener lives as long as the host, and reads the repo of the moment.
  const repo = useRef<string | null>(null);
  repo.current = repoOf(props.repos, props.current);
  const text = useRef(t);
  text.current = t;

  useEffect(() => {
    const open = (draft: TaskDraft | undefined) => {
      if (!repo.current) {
        pushToast({ id: "board-no-repo", text: text.current("board.err.noRepo") });
        return;
      }
      const at = repo.current;
      setReq((r) => ({ repo: at, draft, seq: (r?.seq ?? 0) + 1 }));
    };
    listeners.add(open);
    return () => void listeners.delete(open);
  }, []);

  if (!req) return null;
  return (
    <TaskEditor
      key={req.seq}
      api={api}
      repo={req.repo}
      open
      draft={req.draft}
      onClose={() => setReq(null)}
      onSaved={() => {
        setReq(null);
        pushToast({ id: "board-saved", text: t("board.saved") });
      }}
    />
  );
}
