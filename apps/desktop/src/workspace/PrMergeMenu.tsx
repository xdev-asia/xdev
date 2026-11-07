import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Button, IconButton, Menu } from "@xdev-asia/ui";
import { toApiError, type Api, type ApiError, type MergeBlock, type MergeMethod, type PrMergeInfo, type PrView } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import type { PrStore } from "./prs";

/** Where the merge state and the merge itself come from, when it is not GitHub. */
export interface MergeSource {
  info(): Promise<PrMergeInfo>;
  merge(method: MergeMethod, headOid: string): Promise<void>;
  /** Runs after a merge went through, to reload the review. */
  after(): Promise<void> | void;
  /** The i18n prefix of the strings that differ per host. */
  words: "prReview" | "mrReview";
  /** The message of a failed merge that is not a block. */
  errorText(e: unknown): string;
}

/**
 * The merge control of a PR: the one primary button of the Checks tab, a menu of the methods the
 * repository allows, and a confirmation. A reason shows when GitHub will not merge yet.
 */
export function PrMergeMenu(props: {
  api: Api;
  worktree: string;
  pr: PrView;
  /** Absent with a `source`. */
  prs?: PrStore;
  source?: MergeSource;
  /** Read the merge state again when this changes (the checks, for one). */
  reloadKey?: unknown;
  /** Seeds, for the tests. */
  initialInfo?: PrMergeInfo | null;
  initialMenu?: boolean;
  initialConfirm?: boolean;
  initialMethod?: MergeMethod;
}): JSX.Element | null {
  const { api, worktree, pr, prs, source } = props;
  const words = source?.words ?? "prReview";
  const { t } = useI18n();
  const [info, setInfo] = useState<PrMergeInfo | null>(props.initialInfo ?? null);
  const [method, setMethod] = useState<MergeMethod | null>(props.initialMethod ?? null);
  const [menu, setMenu] = useState(props.initialMenu ?? false);
  const [confirm, setConfirm] = useState(props.initialConfirm ?? false);
  const [busy, setBusy] = useState(false);
  // The read failed; `attempt` makes the retry read again.
  const [readError, setReadError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  // A second merge must wait for the first, even before the state has re-rendered.
  const inFlight = useRef(false);

  useEffect(() => {
    let live = true;
    (source ? source.info() : api.worktreePrMergeInfo(worktree, pr.number)).then(
      (got) => {
        if (!live) return;
        setInfo(got);
        setReadError(null);
      },
      (e) => {
        if (!live) return;
        setInfo(null);
        setReadError(toApiError(e));
      },
    );
    return () => {
      live = false;
    };
  }, [api, worktree, pr.number, pr.state, props.reloadKey, attempt, source]);

  if (pr.state !== "open" && pr.state !== "draft") return null;
  if (!info && readError) {
    return (
      <div className="ws-merge">
        <p className="error-text" role="alert">
          {source ? source.errorText(readError) : t(`error.${readError.code}`)}
          {!source && readError.code === "gh_failed" && readError.detail ? ` ${readError.detail}` : ""}
        </p>
        <Button type="button" variant="secondary" onClick={() => setAttempt(attempt + 1)}>
          {t("prReview.merge.retry")}
        </Button>
      </div>
    );
  }
  if (!info) return null;

  const current: MergeMethod = method && info.methods.includes(method) ? method : info.defaultMethod;
  const block: MergeBlock | null = info.block;

  const headOid = info.headOid;

  async function merge(): Promise<void> {
    if (inFlight.current || block) return;
    inFlight.current = true;
    setConfirm(false);
    setBusy(true);
    setNote(null);
    try {
      if (source) await source.merge(current, headOid);
      else await api.worktreePrMerge(worktree, pr.number, current, headOid);
      setNote({ error: false, text: t(`${words}.merge.done`) });
      if (source) await source.after();
      else await prs?.load(worktree, { checks: true });
    } catch (e) {
      const err = toApiError(e);
      const text =
        err.code === "merge_blocked" && err.detail
          ? t(`${words}.block.${err.detail}`)
          : source
            ? source.errorText(e)
            : `${t(`error.${err.code}`)}${err.code === "gh_failed" && err.detail ? ` ${err.detail}` : ""}`;
      setNote({ error: true, text });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="ws-merge">
      <div className="ws-merge-split">
        <Button type="button" disabled={busy || block !== null} onClick={() => setConfirm(true)}>
          {t(busy ? "prReview.merge.busy" : `prReview.merge.${current}`)}
        </Button>
        {info.methods.length > 1 && (
          <span className="ws-prc-more">
            <IconButton icon="chevron" label={t("prReview.merge.menu")} aria-haspopup="menu" aria-expanded={menu} disabled={busy} onClick={() => setMenu(!menu)} />
            {menu && (
              <Menu
                label={t("prReview.merge.menu")}
                items={info.methods.map((m) => ({
                  label: t(`prReview.merge.${m}`),
                  checked: m === current,
                  onSelect: () => {
                    setMethod(m);
                    setMenu(false);
                  },
                }))}
              />
            )}
          </span>
        )}
      </div>
      {block && <p className="ws-empty">{t(`${words}.block.${block}`)}</p>}
      {note && (
        <p className={note.error ? "error-text" : "ws-empty"} role={note.error ? "alert" : "status"}>
          {note.text}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        title={t(`${words}.merge.confirm.${current}`, { number: pr.number })}
        body={t(`prReview.merge.body.${current}`, { head: pr.head, base: pr.base })}
        warning={info.checksFailed ? t(`${words}.merge.warn.checks`) : undefined}
        confirmLabel={t(`prReview.merge.${current}`)}
        onConfirm={() => void merge()}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
