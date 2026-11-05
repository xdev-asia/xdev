import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Button, IconButton, Menu } from "@xdev-asia/ui";
import { toApiError, type Api, type MergeBlock, type MergeMethod, type PrMergeInfo, type PrView } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import type { PrStore } from "./prs";

/**
 * The merge control of a PR: the one primary button of the Checks tab, a menu of the methods the
 * repository allows, and a confirmation. A reason shows when GitHub will not merge yet.
 */
export function PrMergeMenu(props: {
  api: Api;
  worktree: string;
  pr: PrView;
  prs: PrStore;
  /** Read the merge state again when this changes (the checks, for one). */
  reloadKey?: unknown;
  /** Seeds, for the tests. */
  initialInfo?: PrMergeInfo | null;
  initialMenu?: boolean;
  initialConfirm?: boolean;
  initialMethod?: MergeMethod;
}): JSX.Element | null {
  const { api, worktree, pr, prs } = props;
  const { t } = useI18n();
  const [info, setInfo] = useState<PrMergeInfo | null>(props.initialInfo ?? null);
  const [method, setMethod] = useState<MergeMethod | null>(props.initialMethod ?? null);
  const [menu, setMenu] = useState(props.initialMenu ?? false);
  const [confirm, setConfirm] = useState(props.initialConfirm ?? false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  // A second merge must wait for the first, even before the state has re-rendered.
  const inFlight = useRef(false);

  useEffect(() => {
    let live = true;
    api.worktreePrMergeInfo(worktree, pr.number).then(
      (got) => live && setInfo(got),
      () => live && setInfo(null),
    );
    return () => {
      live = false;
    };
  }, [api, worktree, pr.number, pr.state, props.reloadKey]);

  if (pr.state !== "open" && pr.state !== "draft") return null;
  if (!info) return null;

  const current: MergeMethod = method && info.methods.includes(method) ? method : info.defaultMethod;
  const block: MergeBlock | null = info.block;

  async function merge(): Promise<void> {
    if (inFlight.current || block) return;
    inFlight.current = true;
    setConfirm(false);
    setBusy(true);
    setNote(null);
    try {
      await api.worktreePrMerge(worktree, pr.number, current);
      setNote({ error: false, text: t("prReview.merge.done") });
      await prs.load(worktree, { checks: true });
    } catch (e) {
      const err = toApiError(e);
      const text =
        err.code === "merge_blocked" && err.detail
          ? t(`prReview.block.${err.detail}`)
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
      {block && <p className="ws-empty">{t(`prReview.block.${block}`)}</p>}
      {note && (
        <p className={note.error ? "error-text" : "ws-empty"} role={note.error ? "alert" : "status"}>
          {note.text}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        title={t(`prReview.merge.confirm.${current}`, { number: pr.number })}
        body={t(`prReview.merge.body.${current}`, { head: pr.head, base: pr.base })}
        warning={info.checksFailed ? t("prReview.merge.warn.checks") : undefined}
        confirmLabel={t(`prReview.merge.${current}`)}
        onConfirm={() => void merge()}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
