import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type IssueDetail } from "@/api";
import { renderMarkdown } from "@/doc/markdown";
import { useI18n } from "@/i18n";
import { ago } from "@/workspace/ago";

const REASONS: readonly string[] = ["gh_missing", "gh_auth", "not_github"];
const NO_LINKS = () => null;

/** Read-only markdown: raw HTML is escaped and links stay inert. */
function Markdown(props: { text: string }): JSX.Element {
  return <div className="ws-issue-md preview-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(props.text, "", NO_LINKS) }} />;
}

/** One issue with its body and comments, and the buttons that act on it. */
export function IssueDetailView(props: {
  api: Api;
  repoId: string;
  number: number;
  onBack: () => void;
  onStart?: (detail: IssueDetail) => void;
}): JSX.Element {
  const { api, repoId, number, onBack, onStart } = props;
  const { t } = useI18n();
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let current = true;
    setDetail(null);
    setError(null);
    api
      .issueView(repoId, number)
      .then((d) => current && setDetail(d))
      .catch((e: unknown) => current && setError(toApiError(e)));
    return () => {
      current = false;
    };
  }, [api, repoId, number]);

  async function openWeb(): Promise<void> {
    try {
      await api.issueOpen(repoId, number);
    } catch (e) {
      setError(toApiError(e));
    }
  }

  const now = Date.now();
  const issue = detail?.issue ?? null;
  return (
    <div className="ws-issues ws-issue-detail">
      <div className="ws-checks-actions">
        <button type="button" className="ws-checks-btn" onClick={onBack}>
          {t("issues.back")}
        </button>
        <button type="button" className="ws-checks-btn" onClick={() => void openWeb()}>
          {t("issues.openWeb")}
        </button>
        {onStart && detail && (
          <button type="button" className="ws-checks-btn" onClick={() => onStart(detail)}>
            {t("issues.start")}
          </button>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {REASONS.includes(error.code) ? t(`issues.reason.${error.code}`) : t(`error.${error.code}`)}
          {error.code === "gh_failed" && error.detail ? ` ${error.detail}` : ""}
        </p>
      )}
      {!error && !detail && <p className="ws-empty">{t("issues.loading")}</p>}
      {detail && issue && (
        <>
          <div className="ws-checks-pr">
            <span className="ws-checks-number">{`#${issue.number}`}</span>
            <span className="ws-checks-title" title={issue.title}>
              {issue.title}
            </span>
            <span className="ws-checks-state">{t(`issues.state.${issue.state}`)}</span>
          </div>
          {detail.body.trim() ? <Markdown text={detail.body} /> : <p className="ws-empty">{t("issues.noBody")}</p>}
          <h3 className="ws-issue-comments">{t("issues.comments", { count: detail.comments.length })}</h3>
          <ul className="ws-issues-list">
            {detail.comments.map((c, i) => (
              <li key={i} className="ws-issue-comment">
                <span className="ws-issue-meta">
                  <span>{c.author ?? t("issues.ghost")}</span>
                  <span>{ago(Date.parse(c.createdAt), now, t)}</span>
                </span>
                <Markdown text={c.body} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
