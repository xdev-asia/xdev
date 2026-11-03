import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type WorktreeFileDiff } from "../api";
import type { Problem } from "../changes/useChanges";
import { ProblemNote } from "../components/ChangesPanel";
import { DiffStats, DiffView } from "../components/DiffView";
import { useI18n } from "../i18n";

/** One file of a worktree against its last commit, read once when the tab opens. */
export function WorktreeDiff(props: { api: Api; worktree: string; file: string }): JSX.Element {
  const { api, worktree, file } = props;
  const { t } = useI18n();
  const [diff, setDiff] = useState<WorktreeFileDiff | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setProblem(null);
    api.worktreeFileDiff(worktree, file).then(
      (d) => alive && setDiff(d),
      (e) => alive && setProblem(toApiError(e)),
    );
    return () => {
      alive = false;
    };
  }, [api, worktree, file]);

  const base = diff?.old ?? "";
  const current = diff?.new ?? "";
  return (
    <div className="ws-diff">
      <div className="ws-diff-head">
        <span className="ws-diff-path ws-mono">{file}</span>
        {diff && !diff.skip && <DiffStats base={base} current={current} />}
      </div>
      {problem && <ProblemNote problem={problem} />}
      {diff?.skip === "binary" && <p className="ws-empty">{t("workspace.diff.binary")}</p>}
      {diff?.skip === "too_large" && <p className="ws-empty">{t("workspace.diff.tooLarge")}</p>}
      {diff && !diff.skip && (
        <div className="ws-diff-body">
          <DiffView base={base} current={current} />
        </div>
      )}
    </div>
  );
}
