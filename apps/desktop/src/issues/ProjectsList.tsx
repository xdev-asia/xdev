import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type ProjectSummary } from "@/api";
import { useI18n } from "@/i18n";
import { ghReasonText } from "./ghReason";

/** The GitHub Projects of the repo's owner; a row opens the project in the browser. */
export function ProjectsList(props: { api: Api; repoId: string }): JSX.Element {
  const { api, repoId } = props;
  const { t } = useI18n();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let current = true;
    setProjects(null);
    setError(null);
    api
      .projectsList(repoId)
      .then((list) => current && setProjects(list))
      .catch((e: unknown) => current && setError(toApiError(e)));
    return () => {
      current = false;
    };
  }, [api, repoId]);

  return (
    <div className="ws-issues">
      {error && (
        <p className="error-text" role="alert">
          {ghReasonText(error, t)}
        </p>
      )}
      {!error && projects === null && <p className="ws-empty">{t("issues.projects.loading")}</p>}
      {projects && projects.length === 0 && <p className="ws-empty">{t("issues.projects.empty")}</p>}
      {projects && projects.length > 0 && (
        <ul className="ws-issues-list">
          {projects.map((p) => (
            <li key={p.number} className="ws-issue" data-state={p.closed ? "closed" : "open"}>
              <button type="button" className="ws-issue-open" onClick={() => api.projectOpen(repoId, p.number).catch((e: unknown) => setError(toApiError(e)))}>
                <span className="ws-checks-number">{`#${p.number}`}</span>
                <span className="ws-issue-main">
                  <span className="ws-checks-title" title={p.title}>
                    {p.title}
                  </span>
                  <span className="ws-issue-meta">
                    {p.closed && <span className="ws-tag">{t("issues.projects.closed")}</span>}
                    <span>{t("issues.projects.items", { count: p.items })}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
