import { FilterChip } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type MrSummary, type PrFilter } from "@/api";
import { useI18n } from "@/i18n";
import { ago } from "@/workspace/ago";
import { glabReasonText } from "./glabReason";

const FILTERS: readonly PrFilter[] = ["open", "merged", "closed"];

/** Whether the repo's remote is GitLab: null while it is being asked; a failed ask reads as no. */
export function useGitlab(api: Api | undefined, repoId: string): boolean | null {
  const [found, setFound] = useState<{ repoId: string; gitlab: boolean } | null>(null);
  useEffect(() => {
    if (!api || repoId === "") return;
    let current = true;
    api.gitlabDetect(repoId).then(
      (gitlab) => current && setFound({ repoId, gitlab }),
      () => current && setFound({ repoId, gitlab: false }),
    );
    return () => {
      current = false;
    };
  }, [api, repoId]);
  if (!api || repoId === "") return false;
  return found && found.repoId === repoId ? found.gitlab : null;
}

/** The merge requests of a GitLab repo: state chips, a search box and one row per merge request, as the pull request list has. */
export function MrsList(props: { api: Api; repoId: string; onOpen?: (mr: MrSummary) => void }): JSX.Element {
  const { api, repoId, onOpen } = props;
  const { t } = useI18n();
  const [filter, setFilter] = useState<PrFilter>("open");
  const [search, setSearch] = useState("");
  const [mrs, setMrs] = useState<MrSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let current = true;
    setMrs(null);
    setError(null);
    api
      .gitlabMrList(repoId, filter)
      .then((list) => current && setMrs(list))
      .catch((e: unknown) => current && setError(toApiError(e)));
    return () => {
      current = false;
    };
  }, [api, repoId, filter, tick]);

  const open = (mr: MrSummary): void => {
    if (onOpen) return onOpen(mr);
    api.openUrl(mr.url).catch((e: unknown) => setError(toApiError(e)));
  };
  const needle = search.trim().toLowerCase();
  const shown = mrs?.filter((m) => needle === "" || m.title.toLowerCase().includes(needle)) ?? null;
  const now = Date.now();
  return (
    <div className="ws-issues">
      <div className="ws-issues-bar" role="group" aria-label={t("gitlab.mr.filter")}>
        {FILTERS.map((f) => (
          <FilterChip key={f} pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`issues.prs.state.${f}`)}
          </FilterChip>
        ))}
        <button type="button" className="ws-checks-btn" onClick={() => setTick(tick + 1)}>
          {t("issues.refresh")}
        </button>
      </div>
      <input type="search" className="ws-issues-search" value={search} placeholder={t("gitlab.mr.search")} aria-label={t("gitlab.mr.search")} onChange={(e) => setSearch(e.target.value)} />
      {error && (
        <p className="error-text" role="alert">
          {glabReasonText(error, t)}
        </p>
      )}
      {!error && shown === null && <p className="ws-empty">{t("gitlab.mr.loading")}</p>}
      {shown && shown.length === 0 && <p className="ws-empty">{t("gitlab.mr.empty")}</p>}
      {shown && shown.length > 0 && (
        <ul className="ws-issues-list">
          {shown.map((mr) => (
            <li key={mr.iid} className="ws-issue" data-state={mr.draft ? "draft" : mr.state}>
              <button type="button" className="ws-issue-open" onClick={() => open(mr)}>
                <span className="ws-checks-number">{`!${mr.iid}`}</span>
                <span className="ws-issue-main">
                  <span className="ws-checks-title" title={mr.title}>
                    {mr.title}
                  </span>
                  <span className="ws-issue-meta">
                    <span className="ws-tag">{t(`issues.prs.state.${mr.state}`)}</span>
                    {mr.draft && <span className="ws-tag">{t("gitlab.mr.draft")}</span>}
                    <span className="ws-mono">{`${mr.source} → ${mr.target}`}</span>
                    {mr.author && <span className="ws-issue-who">{mr.author}</span>}
                    <span>{ago(Date.parse(mr.updatedAt), now, t)}</span>
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
