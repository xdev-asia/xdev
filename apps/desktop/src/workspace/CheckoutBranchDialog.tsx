import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type ReviewBranch, type WorktreeView } from "@/api";
import { useI18n } from "@/i18n";

/** The branches that can be checked out: remote-only ones stay, a remote copy of a local branch goes. */
export function checkoutChoices(branches: ReviewBranch[], current: string | null, query: string): ReviewBranch[] {
  const local = new Set(branches.filter((b) => !b.remote).map((b) => b.name));
  const needle = query.trim().toLowerCase();
  return branches
    .filter((b) => b.name !== current)
    .filter((b) => !b.remote || (!local.has(b.name.slice(b.name.indexOf("/") + 1)) && !b.name.endsWith("/HEAD")))
    .filter((b) => needle === "" || b.name.toLowerCase().includes(needle));
}

/** Searchable list of branches; picking one switches the worktree to it. Mounted only while open. */
export function CheckoutBranchDialog(props: { api: Api; worktree: WorktreeView; onDone(): void; onClose(): void }): JSX.Element {
  const { api, worktree } = props;
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [branches, setBranches] = useState<ReviewBranch[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"] | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let alive = true;
    api.worktreeBranches(worktree.path).then(
      (list) => alive && setBranches(list),
      (e) => {
        if (!alive) return;
        setBranches([]);
        setError(toApiError(e).code);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, worktree.path]);

  const choices = useMemo(() => checkoutChoices(branches ?? [], worktree.branch, query), [branches, worktree.branch, query]);

  async function pick(name: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.worktreeCheckoutBranch(worktree.path, name);
      props.onDone();
    } catch (e) {
      setError(toApiError(e).code);
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-checkout-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) props.onClose();
      }}
    >
      <h2 id="ws-checkout-title" className="dialog-title">
        {t("checkout.title")}
      </h2>
      <div className="ws-fields">
        <label className="ws-field">
          <span>{t("checkout.search")}</span>
          <input type="search" name="branchSearch" className="ws-mono" value={query} autoFocus spellCheck={false} disabled={busy} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="rv-base-menu" role="listbox" aria-label={t("checkout.title")} data-checkout-list="">
          {branches === null && <p className="ws-empty">{t("review.loading")}</p>}
          {branches !== null && choices.length === 0 && <p className="ws-empty">{t("checkout.none")}</p>}
          {choices.map((b) => (
            <button key={b.name} type="button" role="option" aria-selected={false} className="ws-mono" disabled={busy} onClick={() => void pick(b.name)}>
              {b.name}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" disabled={busy} onClick={props.onClose}>
          {t("dialog.cancel")}
        </button>
      </div>
    </dialog>
  );
}
