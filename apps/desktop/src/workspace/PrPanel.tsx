import { Button, DiffStat, EmptyState, Select, StatusDot, Tabs, Textarea } from "@xdev-asia/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type Check, type MergeMethod, type PrDetail, type PrEntry, type PrMergeInfo, type ReviewerState } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { renderMarkdown } from "@/doc/markdown";
import { useI18n } from "@/i18n";
import { ago } from "./ago";
import { ChecksPanel } from "./ChecksPanel";
import { CreatePrDialog } from "./CreatePrDialog";
import type { PrCommentStore } from "./prCommentStore";
import { PrReviewers } from "./PrReviewers";
import type { SendChoice } from "./agentPrompt";
import type { CommentGroup } from "./prComments";
import type { SendOutcome } from "./PrSendBar";
import type { PrStore } from "./prs";
import type { Sessions } from "./sessions";

type Tab = "conversation" | "checks" | "files";
type T = (key: string, vars?: Record<string, string | number>) => string;

const REASONS: readonly string[] = ["gh_missing", "gh_auth", "not_github"];
const NO_LINKS = () => null;
const METHODS: MergeMethod[] = ["squash", "merge", "rebase"];

function errorText(error: ApiError, t: T): string {
  const base = REASONS.includes(error.code) ? t(`checks.reason.${error.code}`) : t(`error.${error.code}`);
  return error.code === "gh_failed" && error.detail ? `${base} ${error.detail}` : base;
}

/** The pull request of the current branch: conversation, checks and changed files, with auto-merge. */
export function PrPanel(props: {
  api: Api;
  worktree: string;
  prs: PrStore;
  visible: boolean;
  comments?: PrCommentStore;
  sessions?: Sessions | null;
  onSendComments?(pr: { number: number; title: string; url: string }, groups: CommentGroup[], choice: SendChoice, ack: boolean): Promise<SendOutcome>;
  onFix?(check: Check): void | Promise<void>;
  onFixAll?(checks: Check[]): void | Promise<void>;
  /** Opens the diff of a changed file, by its path in the worktree. Left out, the files only list. */
  onOpenFile?(rel: string): void;
  onOpenGitSettings?(): void;
}): JSX.Element {
  const { api, worktree, prs, visible } = props;
  const { t } = useI18n();
  const [detail, setDetail] = useState<PrDetail | null | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [tab, setTab] = useState<Tab>("conversation");
  const [reply, setReply] = useState("");
  const [posting, setPosting] = useState(false);
  const [info, setInfo] = useState<PrMergeInfo | null>(null);
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [base, setBase] = useState("");
  const [git, setGit] = useState({ prDraft: false, sourceControlAi: false, prGenerateOnOpen: false, prOpenAfterCreate: false });
  // The worktree a response belongs to; an answer for another worktree is dropped.
  const current = useRef(worktree);
  current.current = worktree;

  const load = useCallback(async (): Promise<void> => {
    const at = worktree;
    try {
      const next = await api.worktreePrDetail(at);
      if (current.current !== at) return;
      setDetail(next);
      setError(null);
      if (next) {
        void api.worktreePrMergeInfo(at, next.number).then((i) => current.current === at && setInfo(i), () => undefined);
      } else {
        setInfo(null);
      }
    } catch (e) {
      if (current.current === at) setError(toApiError(e));
    }
  }, [api, worktree]);

  useEffect(() => {
    setDetail(undefined);
    setInfo(null);
    setMethod(null);
    setReply("");
    setTab("conversation");
  }, [worktree]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const methods = info?.methods ?? METHODS;
  const chosen: MergeMethod = method && methods.includes(method) ? method : (info?.defaultMethod ?? "squash");

  async function post(): Promise<void> {
    if (!detail || reply.trim() === "") return;
    setPosting(true);
    try {
      await api.worktreePrComment(worktree, detail.number, reply);
      setReply("");
      await load();
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setPosting(false);
    }
  }

  async function setAuto(on: boolean): Promise<void> {
    if (!detail) return;
    setBusy(true);
    try {
      await api.worktreePrAutoMerge(worktree, detail.number, on ? chosen : null);
      await load();
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  async function startCreate(): Promise<void> {
    try {
      const [ship, settings] = await Promise.all([api.worktreeShip(worktree), api.gitSettings()]);
      setBase(ship.remote && ship.base.startsWith(`${ship.remote}/`) ? ship.base.slice(ship.remote.length + 1) : ship.base);
      setGit(settings);
      setCreating(true);
    } catch (e) {
      setError(toApiError(e));
    }
  }

  if (error && detail === undefined) {
    return (
      <div className="pr-panel">
        <p className="error-text" role="alert">{errorText(error, t)}</p>
        <div className="pr-actions">
          <Button type="button" variant="secondary" onClick={() => void load()}>{t("prPanel.retry")}</Button>
        </div>
      </div>
    );
  }
  if (detail === undefined) {
    return (
      <div className="pr-panel">
        <p className="ws-empty" role="status">{t("prPanel.loading")}</p>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="pr-panel">
        <EmptyState
          title={t("prPanel.none")}
          hint={t("prPanel.none.hint")}
          actions={<Button type="button" onClick={() => void startCreate()}>{t("prPanel.create")}</Button>}
        />
        {error && <p className="error-text" role="alert">{errorText(error, t)}</p>}
        {creating && (
          <CreatePrDialog
            api={api}
            worktree={worktree}
            initial={{ base, title: "", body: "", draft: git.prDraft }}
            ai={git.sourceControlAi}
            generateOnOpen={git.sourceControlAi && git.prGenerateOnOpen}
            openAfterCreate={git.prOpenAfterCreate}
            onOpenGitSettings={props.onOpenGitSettings}
            onCreated={(created) => {
              setCreating(false);
              prs.set(worktree, created);
              void load();
            }}
            onClose={() => setCreating(false)}
          />
        )}
      </div>
    );
  }

  const now = Date.now();
  const failing = (prs.get(worktree)?.checks ?? []).filter((c) => c.bucket === "fail").length;
  const verdict = (state: ReviewerState): string => t(`prPanel.verdict.${state}`);
  const entryLabel = (e: PrEntry): string => (e.kind === "review" && e.review ? verdict(e.review) : t("prPanel.commented"));

  return (
    <div className="pr-panel">
      <header className="pr-head">
        <div className="pr-title-row">
          <span className="pr-number">{`#${detail.number}`}</span>
          <span className="pr-title" title={detail.title}>{detail.title}</span>
        </div>
        <div className="pr-meta">
          <StatusDot pr={detail.state} label={t(`checks.state.${detail.state}`)} />
          {detail.author && <span>{t("prPanel.by", { author: detail.author })}</span>}
          <span className="ws-mono pr-branches" title={`${detail.base} ← ${detail.head}`}>{`${detail.base} ← ${detail.head}`}</span>
        </div>
        <div className="pr-meta">
          {detail.reviewDecision && <span>{t(`prPanel.decision.${detail.reviewDecision}`)}</span>}
          <span>{t(`prPanel.mergeable.${detail.mergeable}`)}</span>
          {detail.mergeState !== "unknown" && <span>{t(`prPanel.mergeState.${detail.mergeState}`)}</span>}
        </div>
        <div className="pr-actions">
          <Button type="button" variant="secondary" onClick={() => void api.worktreePrOpen(worktree, false).catch((e: unknown) => setError(toApiError(e)))}>
            {t("prPanel.openBrowser")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => void load()}>{t("prPanel.refresh")}</Button>
        </div>
      </header>
      {error && (
        <div className="pr-error">
          <p className="error-text" role="alert">{errorText(error, t)}</p>
          <Button type="button" variant="secondary" onClick={() => void load()}>{t("prPanel.retry")}</Button>
        </div>
      )}
      <div className="pr-tabs">
        <Tabs
          label={t("prPanel.tabs")}
          idPrefix="pr"
          value={tab}
          onChange={(id) => setTab(id as Tab)}
          items={[
            { id: "conversation", label: t("prPanel.tab.conversation") },
            { id: "checks", label: t("prPanel.tab.checks"), badge: failing > 0 ? failing : undefined, badgeTone: "danger" },
            { id: "files", label: t("prPanel.tab.files"), badge: detail.files.length || undefined },
          ]}
        />
      </div>
      {tab === "conversation" && (
        <section className="pr-section" id="pr-panel-conversation" role="tabpanel" aria-labelledby="pr-tab-conversation">
          {detail.body.trim() !== "" ? (
            <div className="preview-body pr-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.body, "", NO_LINKS) }} />
          ) : (
            <p className="ws-empty">{t("prPanel.noBody")}</p>
          )}
          <PrReviewers
            api={api}
            worktree={worktree}
            number={detail.number}
            reviewers={detail.reviewers}
            editable={detail.state === "open" || detail.state === "draft"}
            onChanged={load}
            onError={setError}
          />
          <h3 className="pr-h">{t("prPanel.activity")}</h3>
          {detail.entries.length === 0 ? (
            <p className="ws-empty">{t("prPanel.noActivity")}</p>
          ) : (
            <ul className="pr-list">
              {detail.entries.map((e, i) => {
                const at = Date.parse(e.at);
                return (
                  <li key={`${e.at}/${i}`} className="pr-entry">
                    <div className="pr-entry-head">
                      <strong>{e.author}</strong>
                      <span className="pr-muted">{entryLabel(e)}</span>
                      {!Number.isNaN(at) && <span className="pr-muted">{ago(at, now, t)}</span>}
                    </div>
                    {e.body.trim() !== "" && <div className="preview-body pr-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(e.body, "", NO_LINKS) }} />}
                  </li>
                );
              })}
            </ul>
          )}
          <form
            className="pr-reply"
            onSubmit={(ev) => {
              ev.preventDefault();
              void post();
            }}
          >
            <Textarea label={t("prPanel.reply")} rows={4} value={reply} disabled={posting} onChange={(ev) => setReply(ev.target.value)} />
            <Button type="submit" disabled={posting || reply.trim() === ""}>{t(posting ? "prPanel.replying" : "prPanel.replySend")}</Button>
          </form>
          {detail.state === "open" && (
            <div className="pr-auto">
              <h3 className="pr-h">{t("prPanel.auto")}</h3>
              <p className="pr-muted">
                {detail.autoMerge
                  ? t("prPanel.auto.on", { method: t(`prPanel.method.${detail.autoMerge.method}`), by: detail.autoMerge.enabledBy ?? "-" })
                  : t("prPanel.auto.off")}
              </p>
              <div className="pr-actions">
                {!detail.autoMerge && (
                  <Select
                    aria-label={t("prPanel.auto.method")}
                    options={methods.map((m) => ({ value: m, label: t(`prPanel.method.${m}`) }))}
                    value={chosen}
                    disabled={busy}
                    onChange={(ev) => setMethod(ev.target.value as MergeMethod)}
                  />
                )}
                <Button type="button" variant="secondary" disabled={busy} onClick={() => (detail.autoMerge ? void setAuto(false) : setConfirm(true))}>
                  {t(detail.autoMerge ? "prPanel.auto.disable" : "prPanel.auto.enable")}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}
      {tab === "checks" && (
        <section className="pr-section" id="pr-panel-checks" role="tabpanel" aria-labelledby="pr-tab-checks">
          <ChecksPanel
            bare
            api={api}
            worktree={worktree}
            prs={prs}
            comments={props.comments}
            visible={visible}
            sessions={props.sessions}
            onSendComments={props.onSendComments}
            onFix={props.onFix}
            onFixAll={props.onFixAll}
          />
        </section>
      )}
      {tab === "files" && (
        <section className="pr-section" id="pr-panel-files" role="tabpanel" aria-labelledby="pr-tab-files">
          {detail.files.length === 0 ? (
            <p className="ws-empty">{t("prPanel.noFiles")}</p>
          ) : (
            <ul className="pr-list">
              {detail.files.map((f) => (
                <li key={f.path} className="pr-row">
                  {props.onOpenFile ? (
                    <button type="button" className="pr-file" title={f.path} onClick={() => props.onOpenFile?.(f.path)}>{f.path}</button>
                  ) : (
                    <span className="pr-file" title={f.path}>{f.path}</span>
                  )}
                  <DiffStat added={f.additions} removed={f.deletions} labels={{ diffStat: (a, r) => t("prPanel.diffStat", { added: a, removed: r }) }} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <ConfirmDialog
        open={confirm}
        titleId="pr-auto-title"
        title={t("prPanel.auto.confirm.title", { number: detail.number })}
        body={t("prPanel.auto.confirm.body", { method: t(`prPanel.method.${chosen}`), base: detail.base })}
        confirmLabel={t("prPanel.auto.enable")}
        onConfirm={() => {
          setConfirm(false);
          void setAuto(true);
        }}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
