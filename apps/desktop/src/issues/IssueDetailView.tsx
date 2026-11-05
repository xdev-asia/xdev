import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Button, Field, Menu, Popover, Tag, Textarea } from "@xdev-asia/ui";
import { toApiError, type Api, type ApiError, type IssueDetail, type IssueEdit, type IssueLabel } from "@/api";
import { buildIssueEdit, isEmptyEdit, toggled, type IssueChoice } from "@/issues/issueEdit";
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
  const [menu, setMenu] = useState<"state" | "labels" | "assignees" | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [labelOptions, setLabelOptions] = useState<IssueLabel[] | null>(null);
  const [people, setPeople] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<"title" | "body" | null>(null);
  const [draft, setDraft] = useState("");
  const [comment, setComment] = useState("");

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

  async function refresh(): Promise<void> {
    try {
      setDetail(await api.issueView(repoId, number));
    } catch (e) {
      setError(toApiError(e));
    }
  }

  async function apply(edit: IssueEdit): Promise<void> {
    if (isEmptyEdit(edit)) return;
    setBusy(true);
    setNotice(null);
    try {
      const report = await api.issueEdit(repoId, number, edit);
      if (report.failed.length > 0) {
        const parts = report.failed.map((p) => t(`issues.edit.part.${p}`)).join(", ");
        setNotice(`${t("issues.edit.partial", { parts })}${report.error ? ` ${report.error}` : ""}`);
      }
    } catch (e) {
      setError(toApiError(e));
    }
    await refresh();
    setBusy(false);
  }

  function choose(state: NonNullable<IssueChoice["state"]>): void {
    setMenu(null);
    if (detail) void apply(buildIssueEdit(detail, { state }));
  }

  function startEditing(kind: "title" | "body"): void {
    if (!detail) return;
    setDraft(kind === "title" ? detail.issue.title : detail.body);
    setEditing(kind);
  }

  async function saveEditing(): Promise<void> {
    const kind = editing;
    if (!detail || !kind) return;
    setEditing(null);
    await apply(buildIssueEdit(detail, kind === "title" ? { title: draft } : { body: draft }));
  }

  async function postComment(): Promise<void> {
    if (comment.trim() === "") return;
    setBusy(true);
    setNotice(null);
    try {
      await api.issueComment(repoId, number, comment);
      setComment("");
    } catch (e) {
      setError(toApiError(e));
    }
    await refresh();
    setBusy(false);
  }

  function openPicker(kind: "labels" | "assignees"): void {
    if (!detail) return;
    setPick(kind === "labels" ? detail.issue.labels : detail.issue.assignees);
    setMenu(kind);
    if (kind === "labels" && labelOptions === null) {
      api.issueLabels(repoId).then(setLabelOptions).catch(() => setLabelOptions([]));
    }
    if (kind === "assignees" && people === null) {
      api.issueAssignable(repoId).then(setPeople).catch(() => setPeople([]));
    }
  }

  function closePicker(): void {
    const kind = menu;
    setMenu(null);
    if (!detail || (kind !== "labels" && kind !== "assignees")) return;
    void apply(buildIssueEdit(detail, kind === "labels" ? { labels: pick } : { assignees: pick }));
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
        {detail && issue && issue.state === "closed" && (
          <button type="button" className="ws-checks-btn" disabled={busy} onClick={() => choose("reopen")}>
            {t("issues.edit.reopen")}
          </button>
        )}
        {detail && issue && issue.state === "open" && (
          <Popover
            open={menu === "state"}
            onClose={() => setMenu(null)}
            label={t("issues.edit.close")}
            trigger={(aria) => (
              <button type="button" className="ws-checks-btn" disabled={busy} {...aria} onClick={() => setMenu(menu === "state" ? null : "state")}>
                {t("issues.edit.close")}
              </button>
            )}
          >
            <Menu
              label={t("issues.edit.close")}
              items={[
                { label: t("issues.edit.closeCompleted"), onSelect: () => choose("completed") },
                { label: t("issues.edit.closeNotPlanned"), onSelect: () => choose("not_planned") },
              ]}
            />
          </Popover>
        )}
        {detail && issue && (
          <Popover
            open={menu === "labels"}
            onClose={closePicker}
            label={t("issues.edit.labels")}
            trigger={(aria) => (
              <button type="button" className="ws-checks-btn" disabled={busy} {...aria} onClick={() => (menu === "labels" ? closePicker() : openPicker("labels"))}>
                {t("issues.edit.labels")}
              </button>
            )}
          >
            <Menu
              label={t("issues.edit.labels")}
              items={
                labelOptions === null
                  ? [{ label: t("issues.edit.loadingOptions"), disabled: true }]
                  : [...new Set([...labelOptions.map((l) => l.name), ...issue.labels])].map((name) => ({
                      label: name,
                      checked: pick.includes(name),
                      onSelect: () => setPick(toggled(pick, name)),
                    }))
              }
            />
          </Popover>
        )}
        {detail && issue && (
          <Popover
            open={menu === "assignees"}
            onClose={closePicker}
            label={t("issues.edit.assignees")}
            trigger={(aria) => (
              <button type="button" className="ws-checks-btn" disabled={busy} {...aria} onClick={() => (menu === "assignees" ? closePicker() : openPicker("assignees"))}>
                {t("issues.edit.assignees")}
              </button>
            )}
          >
            <Menu
              label={t("issues.edit.assignees")}
              items={
                people === null
                  ? [{ label: t("issues.edit.loadingOptions"), disabled: true }]
                  : [...new Set([...people, ...issue.assignees])].map((login) => ({
                      label: login,
                      checked: pick.includes(login),
                      onSelect: () => setPick(toggled(pick, login)),
                    }))
              }
            />
          </Popover>
        )}
        {detail && (
          <button type="button" className="ws-checks-btn" disabled={busy} onClick={() => startEditing("title")}>
            {t("issues.edit.title")}
          </button>
        )}
        {detail && (
          <button type="button" className="ws-checks-btn" disabled={busy} onClick={() => startEditing("body")}>
            {t("issues.edit.body")}
          </button>
        )}
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
      {notice && (
        <p className="error-text" role="status">
          {notice}
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
          <div className="ws-issue-meta">
            {issue.labels.length > 0 ? issue.labels.map((l) => <Tag key={l}>{l}</Tag>) : <span>{t("issues.edit.none")}</span>}
            <span>{issue.assignees.length > 0 ? issue.assignees.join(", ") : t("issues.edit.none")}</span>
          </div>
          {editing && (
            <div className="ws-issue-edit">
              {editing === "title" ? (
                <Field label={t("issues.edit.title")} value={draft} onChange={(e) => setDraft(e.target.value)} />
              ) : (
                <Textarea label={t("issues.edit.body")} value={draft} rows={8} onChange={(e) => setDraft(e.target.value)} />
              )}
              <div className="ws-checks-actions">
                <Button disabled={busy || (editing === "title" && draft.trim() === "")} onClick={() => void saveEditing()}>
                  {t("issues.edit.save")}
                </Button>
                <Button variant="secondary" onClick={() => setEditing(null)}>
                  {t("issues.edit.cancel")}
                </Button>
              </div>
            </div>
          )}
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
          <div className="ws-issue-edit">
            <Textarea
              label={t("issues.comment.placeholder")}
              value={comment}
              rows={4}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="ws-checks-actions">
              <Button variant="secondary" disabled={busy || comment.trim() === ""} onClick={() => void postComment()}>
                {t("issues.comment.post")}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
