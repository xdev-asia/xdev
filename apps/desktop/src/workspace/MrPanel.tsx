import { Button, Comment, EmptyState, StatusDot, Tabs } from "@xdev-asia/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type Check, type MrDetail, type MrNote } from "@/api";
import { renderMarkdown } from "@/doc/markdown";
import { useI18n } from "@/i18n";
import { glabReasonText } from "@/issues/glabReason";
import { ago } from "./ago";
import { CreatePrDialog } from "./CreatePrDialog";
import { PrComposer } from "./PrComposer";
import { PrMergeMenu, type MergeSource } from "./PrMergeMenu";
import { mrAsPr } from "./ship";

type Tab = "conversation" | "pipeline";

const NO_LINKS = () => null;

interface Loaded {
  detail: MrDetail;
  notes: MrNote[];
  truncated: boolean;
  jobs: Check[];
}

/**
 * The merge request of the current branch on GitLab: its description and comments, the pipeline
 * and its jobs, and the merge. As a page (a workspace tab) it shows both parts side by side.
 */
export function MrPanel(props: {
  api: Api;
  worktree: string;
  visible: boolean;
  onOpenGitSettings?(): void;
  /** Laid out as the full page instead of the side panel. */
  page?: boolean;
  /** Opens the full page; left out, the panel has no way there. */
  onOpenPage?(): void;
}): JSX.Element {
  const { api, worktree, visible } = props;
  const page = props.page === true;
  const { t } = useI18n();
  // undefined: not read yet; null: the branch has no merge request.
  const [loaded, setLoaded] = useState<Loaded | null | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("conversation");
  const [creating, setCreating] = useState(false);
  const [base, setBase] = useState("");
  const [git, setGit] = useState({ prDraft: false, sourceControlAi: false, prGenerateOnOpen: false, prOpenAfterCreate: false });
  // The worktree a response belongs to; an answer for another worktree is dropped.
  const current = useRef(worktree);
  current.current = worktree;

  const load = useCallback(async (): Promise<void> => {
    const at = worktree;
    try {
      const mr = await api.worktreeMr(at);
      if (current.current !== at) return;
      if (!mr) {
        setLoaded(null);
        setError(null);
        return;
      }
      const detail = await api.worktreeMrDetail(at, mr.iid);
      const [notes, jobs] = await Promise.all([
        api.worktreeMrNotes(at, mr.iid),
        detail.pipeline ? api.worktreeMrJobs(at, detail.pipeline.id) : Promise.resolve<Check[]>([]),
      ]);
      if (current.current !== at) return;
      setLoaded({ detail, notes: notes.notes, truncated: notes.truncated, jobs });
      setError(null);
    } catch (e) {
      if (current.current === at) setError(toApiError(e));
    }
  }, [api, worktree]);

  useEffect(() => {
    setLoaded(undefined);
    setError(null);
    setPostError(null);
    setTab("conversation");
    setCreating(false);
  }, [worktree]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const iid = loaded?.detail.summary.iid;
  const source = useMemo<MergeSource | null>(() => {
    if (iid === undefined) return null;
    return {
      info: () => api.worktreeMrMergeInfo(worktree, iid),
      merge: (method, headOid) => api.worktreeMrMerge(worktree, iid, method, headOid),
      after: () => load(),
      words: "mrReview",
      errorText: (e) => {
        const err = toApiError(e);
        return err.code === "pr_head_moved" ? t("mrReview.headMoved") : glabReasonText(err, t);
      },
    };
  }, [api, worktree, iid, load, t]);

  async function post(body: string): Promise<boolean> {
    if (iid === undefined) return false;
    try {
      await api.worktreeMrNotePost(worktree, iid, body);
      setPostError(null);
      await load();
      return true;
    } catch (e) {
      setPostError(glabReasonText(toApiError(e), t));
      return false;
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

  if (error && loaded === undefined) {
    return (
      <div className="pr-panel">
        <p className="error-text" role="alert">{glabReasonText(error, t)}</p>
        <div className="pr-actions">
          <Button type="button" variant="secondary" onClick={() => void load()}>{t("prPanel.retry")}</Button>
        </div>
      </div>
    );
  }
  if (loaded === undefined) {
    return (
      <div className="pr-panel">
        <p className="ws-empty" role="status">{t("mrPanel.loading")}</p>
      </div>
    );
  }

  if (loaded === null) {
    return (
      <div className="pr-panel">
        <EmptyState
          title={t("mrPanel.none")}
          hint={t("mrPanel.none.hint")}
          actions={<Button type="button" onClick={() => void startCreate()}>{t("ship.mr.create")}</Button>}
        />
        {error && <p className="error-text" role="alert">{glabReasonText(error, t)}</p>}
        {creating && (
          <CreatePrDialog
            api={api}
            worktree={worktree}
            host="gitlab"
            initial={{ base, title: "", body: "", draft: git.prDraft }}
            ai={git.sourceControlAi}
            generateOnOpen={git.sourceControlAi && git.prGenerateOnOpen}
            openAfterCreate={git.prOpenAfterCreate}
            onOpenGitSettings={props.onOpenGitSettings}
            onCreated={() => {
              setCreating(false);
              void load();
            }}
            onClose={() => setCreating(false)}
          />
        )}
      </div>
    );
  }

  const { detail, notes, truncated, jobs } = loaded;
  const mr = detail.summary;
  const pr = mrAsPr(mr);
  const now = Date.now();
  const failing = jobs.filter((j) => j.bucket === "fail").length;

  const description =
    detail.body.trim() !== "" ? (
      <div className="preview-body pr-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.body, "", NO_LINKS) }} />
    ) : (
      <p className="ws-empty">{t("mrPanel.noBody")}</p>
    );
  const conversation = (
    <>
      <h3 className="pr-h">{t("mrPanel.notes")}</h3>
      {truncated && <p className="pr-muted">{t("mrPanel.truncated")}</p>}
      {notes.length === 0 ? (
        <p className="ws-empty">{t("mrPanel.noNotes")}</p>
      ) : (
        <ul className="pr-list">
          {notes.map((n) => {
            const at = Date.parse(n.createdAt);
            return (
              <li key={n.id} className="pr-entry">
                <Comment author={n.author} time={Number.isNaN(at) ? undefined : ago(at, now, t)}>
                  <div className="preview-body pr-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(n.body, "", NO_LINKS) }} />
                </Comment>
              </li>
            );
          })}
        </ul>
      )}
      <PrComposer label={t("mrPanel.compose")} submitLabel={t("mrPanel.send")} onSubmit={post} error={postError} />
    </>
  );
  const merge = source && <PrMergeMenu api={api} worktree={worktree} pr={pr} source={source} reloadKey={detail.headSha} />;
  const pipeline = (
    <>
      {detail.pipeline ? (
        <p className="pr-muted">{t("mrPanel.pipeline.status", { id: detail.pipeline.id, status: t(`checks.bucket.${detail.pipeline.bucket}`) })}</p>
      ) : (
        <p className="ws-empty">{t("mrPanel.pipeline.none")}</p>
      )}
      {detail.pipeline && jobs.length === 0 ? (
        <p className="ws-empty">{t("checks.none")}</p>
      ) : (
        jobs.length > 0 && (
          <ul className="ws-checks-list">
            {jobs.map((j, i) => (
              <li key={`${j.workflow ?? ""}/${j.name}/${i}`} className="ws-check" data-bucket={j.bucket}>
                <span className={j.bucket === "pending" ? "ws-dot ws-pulse" : "ws-dot"} data-check={j.bucket} role="img" aria-label={t(`checks.bucket.${j.bucket}`)} title={t(`checks.bucket.${j.bucket}`)} />
                <span className="ws-check-name" title={j.name}>{j.name}</span>
                {j.workflow && <span className="ws-check-workflow">{j.workflow}</span>}
                {j.link && (
                  <button type="button" className="ws-checks-btn" onClick={() => void api.openUrl(j.link!).catch((e: unknown) => setError(toApiError(e)))}>
                    {t("mrPanel.pipeline.open")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )
      )}
    </>
  );

  return (
    <div className={page ? "pr-panel pr-page" : "pr-panel"}>
      <header className="pr-head">
        <div className="pr-title-row">
          <span className="pr-number">{`!${mr.iid}`}</span>
          <span className="pr-title" title={mr.title}>{mr.title}</span>
        </div>
        <div className="pr-meta">
          <StatusDot pr={pr.state} label={t(`checks.state.${pr.state}`)} />
          {mr.author && <span>{t("prPanel.by", { author: mr.author })}</span>}
          <span className="ws-mono pr-branches" title={`${mr.target} ← ${mr.source}`}>{`${mr.target} ← ${mr.source}`}</span>
        </div>
        <div className="pr-actions">
          <Button type="button" variant="secondary" onClick={() => void api.openUrl(mr.url).catch((e: unknown) => setError(toApiError(e)))}>
            {t("prPanel.openBrowser")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => void load()}>{t("prPanel.refresh")}</Button>
          {!page && props.onOpenPage && (
            <Button type="button" variant="secondary" onClick={props.onOpenPage}>{t("prPanel.openPage")}</Button>
          )}
        </div>
      </header>
      {error && (
        <div className="pr-error">
          <p className="error-text" role="alert">{glabReasonText(error, t)}</p>
          <Button type="button" variant="secondary" onClick={() => void load()}>{t("prPanel.retry")}</Button>
        </div>
      )}
      {page ? (
        <div className="pr-page-cols">
          <div className="pr-page-main">
            {description}
            {conversation}
          </div>
          <div className="pr-page-side">
            {merge}
            <section className="pr-section" aria-labelledby="mr-page-pipeline">
              <h3 id="mr-page-pipeline" className="pr-h">{t("mrPanel.tab.pipeline")}</h3>
              {pipeline}
            </section>
          </div>
        </div>
      ) : (
        <>
          <div className="pr-tabs">
            <Tabs
              label={t("mrPanel.tabs")}
              idPrefix="mr"
              value={tab}
              onChange={(id) => setTab(id as Tab)}
              items={[
                { id: "conversation", label: t("prPanel.tab.conversation") },
                { id: "pipeline", label: t("mrPanel.tab.pipeline"), badge: failing > 0 ? failing : undefined, badgeTone: "danger" },
              ]}
            />
          </div>
          {tab === "conversation" && (
            <section className="pr-section" id="mr-panel-conversation" role="tabpanel" aria-labelledby="mr-tab-conversation">
              {description}
              {conversation}
            </section>
          )}
          {tab === "pipeline" && (
            <section className="pr-section" id="mr-panel-pipeline" role="tabpanel" aria-labelledby="mr-tab-pipeline">
              {merge}
              {pipeline}
            </section>
          )}
        </>
      )}
    </div>
  );
}
