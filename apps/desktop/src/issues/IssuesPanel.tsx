import { Segmented } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type Issue, type IssueDetail, type PrSummary } from "@/api";
import { useI18n } from "@/i18n";
import { ago } from "@/workspace/ago";
import { IssueDetailView } from "./IssueDetailView";
import { issueQuery } from "./issueStart";
import { NewIssueForm } from "./NewIssueForm";
import { PrsList } from "./PrsList";
import { ProjectsList } from "./ProjectsList";

export const SEARCH_DEBOUNCE_MS = 300;
const REASONS: readonly string[] = ["gh_missing", "gh_auth", "not_github"];

type Filter = "open" | "closed";
export type IssuesView = "issues" | "prs" | "projects";

/** The GitHub issues of a repo: filters, search and one row per issue. */
export function IssuesPanel(props: { api: Api; repoId: string; onStart?: (detail: IssueDetail) => void; /** A pull request row was clicked; without it the row opens on GitHub. */ onOpenPr?: (pr: PrSummary) => void }): JSX.Element {
  const { api, repoId, onStart } = props;
  const { t } = useI18n();
  const [state, setState] = useState<Filter>("open");
  const [mine, setMine] = useState(false);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [tick, setTick] = useState(0);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<IssuesView>("issues");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (draft === search) return;
    const id = setTimeout(() => setSearch(draft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [draft, search]);

  useEffect(() => {
    let current = true;
    setIssues(null);
    setError(null);
    api
      .issuesList(repoId, issueQuery({ state, assigneeMe: mine, search: search.trim() || null }))
      .then((list) => current && setIssues(list))
      .catch((e: unknown) => current && setError(toApiError(e)));
    return () => {
      current = false;
    };
  }, [api, repoId, state, mine, search, tick]);

  if (selected !== null) {
    return <IssueDetailView api={api} repoId={repoId} number={selected} onBack={() => setSelected(null)} onStart={onStart} />;
  }
  const views = (
    <Segmented
      label={t("issues.view.label")}
      value={view}
      onChange={(v) => {
        setView(v as IssuesView);
        setAdding(false);
      }}
      options={(["issues", "prs", "projects"] as const).map((v) => ({ value: v, label: t(`issues.view.${v}`) }))}
    />
  );
  if (view === "prs") {
    return (
      <div className="ws-issues">
        {views}
        <PrsList api={api} repoId={repoId} searchDebounceMs={SEARCH_DEBOUNCE_MS} onOpen={props.onOpenPr} />
      </div>
    );
  }
  if (view === "projects") {
    return (
      <div className="ws-issues">
        {views}
        <ProjectsList api={api} repoId={repoId} />
      </div>
    );
  }
  if (adding) {
    return (
      <div className="ws-issues">
        {views}
        <NewIssueForm
          api={api}
          repoId={repoId}
          onCreated={(issue) => {
            setAdding(false);
            setSelected(issue.number);
          }}
          onCancel={() => setAdding(false)}
        />
      </div>
    );
  }
  const now = Date.now();
  return (
    <div className="ws-issues">
      {views}
      <div className="ws-issues-bar">
        <div className="ws-issues-states" role="group" aria-label={t("issues.state")}>
          {(["open", "closed"] as const).map((s) => (
            <button key={s} type="button" className="ws-checks-btn" aria-pressed={state === s} onClick={() => setState(s)}>
              {t(`issues.state.${s}`)}
            </button>
          ))}
        </div>
        <label className="ws-issues-mine">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          {t("issues.mine")}
        </label>
        <button type="button" className="ws-checks-btn" onClick={() => setTick(tick + 1)}>
          {t("issues.refresh")}
        </button>
        <button type="button" className="ws-checks-btn" onClick={() => setAdding(true)}>
          {t("issues.new.open")}
        </button>
      </div>
      <input
        type="search"
        className="ws-issues-search"
        value={draft}
        placeholder={t("issues.search")}
        aria-label={t("issues.search")}
        onChange={(e) => setDraft(e.target.value)}
      />
      {error && (
        <p className="error-text" role="alert">
          {REASONS.includes(error.code) ? t(`issues.reason.${error.code}`) : t(`error.${error.code}`)}
          {error.code === "gh_failed" && error.detail ? ` ${error.detail}` : ""}
        </p>
      )}
      {!error && issues === null && <p className="ws-empty">{t("issues.loading")}</p>}
      {issues && issues.length === 0 && <p className="ws-empty">{t("issues.empty")}</p>}
      {issues && issues.length > 0 && (
        <ul className="ws-issues-list">
          {issues.map((issue) => (
            <li key={issue.number} className="ws-issue" data-state={issue.state}>
              <button type="button" className="ws-issue-open" onClick={() => setSelected(issue.number)}>
              <span className="ws-checks-number">{`#${issue.number}`}</span>
              <span className="ws-issue-main">
                <span className="ws-checks-title" title={issue.title}>
                  {issue.title}
                </span>
                <span className="ws-issue-meta">
                  {issue.labels.map((label) => (
                    <span key={label} className="ws-tag">
                      {label}
                    </span>
                  ))}
                  {issue.assignees.length > 0 && <span className="ws-issue-who">{issue.assignees.join(", ")}</span>}
                  <span>{ago(Date.parse(issue.updatedAt), now, t)}</span>
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
