import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { Button, Disclosure, FilterChip, Segmented } from "@xdev-asia/ui";
import type { ApiError, PrComment } from "@/api";
import { useI18n } from "@/i18n";
import { openFile } from "@/files/openFile";
import { PrCommentRow } from "./PrCommentRow";
import { PrComposer } from "./PrComposer";
import type { PrCommentStore } from "./prCommentStore";
import { audienceCounts, filterAudience, groupComments, timeline, type Audience, type CommentGroup } from "./prComments";

export type CommentView = "grouped" | "timeline";
const AUDIENCES: readonly Audience[] = ["all", "humans", "bots"];
/** GitHub gives the first 100 of each source. */
const PER_SOURCE = 100;

/** The review comments of a worktree's PR: read them, answer, resolve, react and filter bots. */
export function PrComments(props: {
  store: PrCommentStore;
  worktree: string;
  number: number;
  overrides: readonly string[];
  /** Read again when this changes. */
  reloadKey?: unknown;
  onMarkBot: (login: string, mark: boolean) => void;
  /** Seeds, for the tests. */
  initialView?: CommentView;
  initialAudience?: Audience;
  now?: number;
}): JSX.Element {
  const { store, worktree, number, overrides } = props;
  const { t } = useI18n();
  const [view, setView] = useState<CommentView>(props.initialView ?? "grouped");
  const [audience, setAudience] = useState<Audience>(props.initialAudience ?? "all");
  const [replying, setReplying] = useState<number | null>(null);
  const [postError, setPostError] = useState<string | null>(null);

  useSyncExternalStore(useCallback((fn: () => void) => store.subscribe(fn), [store]), store.snapshot, store.snapshot);
  const entry = store.get(worktree);
  const all = entry?.number === number ? entry.comments : [];
  const now = props.now ?? Date.now();

  useEffect(() => {
    void store.load(worktree, number);
  }, [store, worktree, number, props.reloadKey]);

  const counts = useMemo(() => audienceCounts(all, overrides), [all, overrides]);
  const shown = useMemo(() => filterAudience(all, audience, overrides), [all, audience, overrides]);
  const error: ApiError | null = entry?.error ?? null;

  async function post(body: string, replyTo: PrComment | null): Promise<boolean> {
    try {
      await store.post(worktree, number, { body, replyTo: replyTo ? (replyTo.replyTo ?? replyTo.id) : null, path: null, line: null, startLine: null });
      setPostError(null);
      setReplying(null);
      return true;
    } catch (e) {
      const code = (e as ApiError | undefined)?.code;
      setPostError(code === "comment_too_large" || code === "empty_comment" ? t(`error.${code}`) : t("prc.err.post"));
      return false;
    }
  }

  function row(c: PrComment, root: boolean, group?: CommentGroup): JSX.Element {
    const canReply = c.kind === "thread" && (group ? group.root.id === c.id : true);
    return (
      <PrCommentRow
        key={c.id}
        comment={c}
        now={now}
        overrides={overrides}
        canResolve={root && c.kind === "thread"}
        onResolve={(id, resolved) => void store.resolve(worktree, id, resolved)}
        onReact={(id, content, on) => void store.react(worktree, id, content, on)}
        onMarkBot={props.onMarkBot}
        onOpen={(path, line) => openFile({ worktree, rel: path, line: line ?? undefined })}
        footer={
          canReply ? (
            replying === c.id ? (
              <PrComposer label={t("prc.replyTo", { author: c.author })} submitLabel={t("prc.reply")} error={postError} onCancel={() => setReplying(null)} onSubmit={(body) => post(body, c)} />
            ) : (
              <Button type="button" variant="secondary" onClick={() => setReplying(c.id)}>
                {t("prc.reply")}
              </Button>
            )
          ) : null
        }
      />
    );
  }

  const groupBlock = (g: CommentGroup) => (
    <li key={g.key} className="ws-prc-group">
      {row(g.root, true, g)}
      {g.replies.length > 0 && <ul className="ws-prc-replies">{g.replies.map((r) => <li key={r.id}>{row(r, false)}</li>)}</ul>}
    </li>
  );

  const groups = groupComments(shown);
  const truncated = entry?.truncated === true;

  return (
    <section className="ws-prc" aria-label={t("prc.title", { count: all.length })}>
      <div className="ws-prc-head">
        <h3 className="ws-prc-title">{t("prc.title", { count: all.length })}</h3>
        <Segmented
          label={t("prc.view.label")}
          value={view}
          onChange={(v) => setView(v as CommentView)}
          options={[
            { value: "grouped", label: t("prc.view.grouped") },
            { value: "timeline", label: t("prc.view.timeline") },
          ]}
        />
      </div>
      <div className="ws-prc-chips" role="group" aria-label={t("prc.audience.label")}>
        {AUDIENCES.map((a) => (
          <FilterChip key={a} pressed={audience === a} count={counts[a]} onClick={() => setAudience(a)}>
            {t(`prc.audience.${a}`)}
          </FilterChip>
        ))}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error.code}`)}
          {error.code === "gh_failed" && error.detail ? ` ${error.detail}` : ""}
        </p>
      )}
      {truncated && <p className="ws-empty">{t("prc.truncated", { count: PER_SOURCE })}</p>}
      {shown.length === 0 ? (
        <p className="ws-empty">{t(`prc.empty.${audience}`)}</p>
      ) : view === "timeline" ? (
        <ul className="ws-prc-list">
          {timeline(shown).map((c) => (
            <li key={c.id} className="ws-prc-group">
              {row(c, c.kind === "thread" && c.replyTo === null)}
            </li>
          ))}
        </ul>
      ) : (
        <>
          {groups.needsReview.length > 0 && (
            <Disclosure title={t("prc.group.needs")} count={groups.needsReview.length}>
              <ul className="ws-prc-list">{groups.needsReview.map(groupBlock)}</ul>
            </Disclosure>
          )}
          {groups.conversation.length > 0 && (
            <Disclosure title={t("prc.group.conversation")} count={groups.conversation.length}>
              <ul className="ws-prc-list">{groups.conversation.map(groupBlock)}</ul>
            </Disclosure>
          )}
          {groups.resolved.length > 0 && (
            <Disclosure title={t("prc.group.resolved")} count={groups.resolved.length} defaultExpanded={false}>
              <ul className="ws-prc-list">{groups.resolved.map(groupBlock)}</ul>
            </Disclosure>
          )}
        </>
      )}
      <PrComposer
        label={t(all.length === 0 ? "prc.compose.start" : "prc.compose.add")}
        submitLabel={t("prc.send")}
        error={replying === null ? postError : null}
        onSubmit={(body) => post(body, null)}
      />
    </section>
  );
}
