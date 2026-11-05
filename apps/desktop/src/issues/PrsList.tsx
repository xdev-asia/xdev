import { FilterChip } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type PrQuery, type PrSummary } from "@/api";
import { useI18n } from "@/i18n";
import { ago } from "@/workspace/ago";
import { ghReasonText } from "./ghReason";
import { prQuery } from "./issueStart";
import { MrsList, useGitlab } from "./MrsList";

export type PrChip = "open" | "mine" | "review";

/** The query a chip stands for: open pull requests, the ones I wrote, or the ones that ask for my review. */
export function chipQuery(chip: PrChip, search: string | null): PrQuery {
  return prQuery({ state: "open", mine: chip === "mine", needsReview: chip === "review", search });
}

/**
 * The pull requests of a repo: three filter chips, a search box and one row per pull request. When
 * the remote turns out to be GitLab the merge requests are listed instead. The pull request list
 * starts at once, so a GitHub repo does not wait on the remote check; its error is held back until
 * the check is done, so a GitLab repo never shows a `gh` error.
 */
export function PrsList(props: { api: Api; repoId: string; searchDebounceMs: number; initialChip?: PrChip; onOpen?: (pr: PrSummary) => void }): JSX.Element {
  const { api, repoId, onOpen } = props;
  const { t } = useI18n();
  const [chip, setChip] = useState<PrChip>(props.initialChip ?? "open");
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [prs, setPrs] = useState<PrSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);
  const gitlab = useGitlab(api, repoId);

  useEffect(() => {
    if (draft === search) return;
    const id = setTimeout(() => setSearch(draft), props.searchDebounceMs);
    return () => clearTimeout(id);
  }, [draft, search, props.searchDebounceMs]);

  useEffect(() => {
    let current = true;
    setPrs(null);
    setError(null);
    api
      .prsList(repoId, chipQuery(chip, search.trim() || null))
      .then((list) => current && setPrs(list))
      .catch((e: unknown) => current && setError(toApiError(e)));
    return () => {
      current = false;
    };
  }, [api, repoId, chip, search, tick]);

  const open = (pr: PrSummary): void => {
    if (onOpen) return onOpen(pr);
    api.prOpen(repoId, pr.number).catch((e: unknown) => setError(toApiError(e)));
  };
  const now = Date.now();
  if (gitlab === true) return <MrsList api={api} repoId={repoId} />;
  return (
    <div className="ws-issues">
      <div className="ws-issues-bar" role="group" aria-label={t("issues.prs.filter")}>
        {(["open", "mine", "review"] as const).map((c) => (
          <FilterChip key={c} pressed={chip === c} onClick={() => setChip(c)}>
            {t(`issues.prs.chip.${c}`)}
          </FilterChip>
        ))}
        <button type="button" className="ws-checks-btn" onClick={() => setTick(tick + 1)}>
          {t("issues.refresh")}
        </button>
      </div>
      <input
        type="search"
        className="ws-issues-search"
        value={draft}
        placeholder={t("issues.prs.search")}
        aria-label={t("issues.prs.search")}
        onChange={(e) => setDraft(e.target.value)}
      />
      {error && gitlab === false && (
        <p className="error-text" role="alert">
          {ghReasonText(error, t)}
        </p>
      )}
      {(!error || gitlab === null) && prs === null && <p className="ws-empty">{t("issues.prs.loading")}</p>}
      {prs && prs.length === 0 && <p className="ws-empty">{t("issues.prs.empty")}</p>}
      {prs && prs.length > 0 && (
        <ul className="ws-issues-list">
          {prs.map((pr) => (
            <li key={pr.number} className="ws-issue" data-state={pr.state}>
              <button type="button" className="ws-issue-open" onClick={() => open(pr)}>
                <span className="ws-checks-number">{`#${pr.number}`}</span>
                <span className="ws-issue-main">
                  <span className="ws-checks-title" title={pr.title}>
                    {pr.title}
                  </span>
                  <span className="ws-issue-meta">
                    <span className="ws-tag">{t(`issues.prs.state.${pr.state}`)}</span>
                    <span className="ws-mono">{`${pr.head} → ${pr.base}`}</span>
                    {pr.author && <span className="ws-issue-who">{pr.author}</span>}
                    <span>{ago(Date.parse(pr.updatedAt), now, t)}</span>
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
