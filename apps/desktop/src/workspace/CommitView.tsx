import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type CommitFiles, type WorktreeFileDiff } from "@/api";
import { DiffView } from "@/components/DiffView";
import { useI18n } from "@/i18n";

const SHORT = 7;

// Git's own letters, so they read the same in every language.
const LETTER: Record<string, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", "type-changed": "T" };

/** A commit asked for: the file to open first (null opens them all); a new `seq` asks again. */
export type CommitAsk = { id: string; file: string | null; seq: number };

/** One file of a commit: its two sides read when it is shown, drawn as a diff. */
export function CommitFileDiff(props: { api: Api; worktree: string; id: string; file: string }): JSX.Element {
  const { api, worktree, id, file } = props;
  const { t } = useI18n();
  const [diff, setDiff] = useState<WorktreeFileDiff | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let live = true;
    setDiff(null);
    setError(null);
    api.worktreeCommitFile(worktree, id, file).then(
      (d) => live && setDiff(d),
      (e) => live && setError(toApiError(e)),
    );
    return () => {
      live = false;
    };
  }, [api, worktree, id, file]);

  if (error) return <p className="error-text ws-commit-note">{t("commitView.failed")}</p>;
  if (!diff) return <p className="ws-empty ws-commit-note">{t("commitView.fileLoading")}</p>;
  if (diff.skip === "binary") return <p className="ws-empty ws-commit-note">{t("workspace.diff.binary")}</p>;
  if (diff.skip === "too_large") return <p className="ws-empty ws-commit-note">{t("workspace.diff.tooLarge")}</p>;
  return <DiffView base={diff.old ?? ""} current={diff.new ?? ""} />;
}

/**
 * The commit tab: the files a commit changed against its first parent, each one opening to its diff.
 * The ask picks which are open first; a click opens or closes any of them.
 */
export function CommitView(props: { api: Api; worktree: string; commit: CommitAsk }): JSX.Element {
  const { api, worktree, commit } = props;
  const { t } = useI18n();
  const [files, setFiles] = useState<CommitFiles | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  // The paths the person opened or closed since the last ask; null follows the ask.
  const [open, setOpen] = useState<string[] | null>(null);

  useEffect(() => {
    let live = true;
    setFiles(null);
    setError(null);
    api.worktreeCommitFiles(worktree, commit.id).then(
      (f) => live && setFiles(f),
      (e) => live && setError(toApiError(e)),
    );
    return () => {
      live = false;
    };
  }, [api, worktree, commit.id]);

  useEffect(() => setOpen(null), [commit.seq]);

  const short = commit.id.slice(0, SHORT);
  const shown = open ?? (commit.file ? [commit.file] : (files?.files.map((f) => f.path) ?? []));
  const toggle = (path: string) => setOpen(shown.includes(path) ? shown.filter((p) => p !== path) : [...shown, path]);

  return (
    <div className="ws-commit">
      <div className="ws-commit-head">
        <strong>{t("commitView.title", { id: short })}</strong>
        {files && <span className="ws-commit-base">{t("commitView.base", { base: files.parent ? files.parent.slice(0, SHORT) : t("commitView.emptyTree") })}</span>}
      </div>
      {!files && !error && <p className="ws-empty ws-commit-note">{t("commitView.loading")}</p>}
      {error && <p className="error-text ws-commit-note">{error.code === "git" ? t("commitView.unresolved", { id: short }) : t("commitView.failed")}</p>}
      {files && files.files.length === 0 && <p className="ws-empty ws-commit-note">{t("commitView.none")}</p>}
      {files && files.files.length > 0 && (
        <ul className="ws-commit-files">
          {files.files.map((f) => {
            const isOpen = shown.includes(f.path);
            const slash = f.path.lastIndexOf("/");
            return (
              <li key={f.path} className="ws-commit-file">
                <button type="button" className="ws-commit-row" data-file={f.path} aria-expanded={isOpen} onClick={() => toggle(f.path)}>
                  <span className="ws-history-letter" data-status={f.status}>{LETTER[f.status] ?? "M"}</span>
                  <span className="ws-history-fname">{slash < 0 ? f.path : f.path.slice(slash + 1)}</span>
                  {slash >= 0 && <span className="ws-history-dir">{f.path.slice(0, slash)}</span>}
                </button>
                {isOpen && <CommitFileDiff api={api} worktree={worktree} id={commit.id} file={f.path} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
