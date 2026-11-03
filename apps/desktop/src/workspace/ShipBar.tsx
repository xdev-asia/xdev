import { Button } from "@xdev/ui";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type PrView, type ShipView } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { CreatePrDialog } from "./CreatePrDialog";
import type { PrStore } from "./prs";
import { shipAction } from "./ship";

const SHORT = 7;

// What a force push was asked about, kept from the moment the person saw it.
type Force = { remote: string; branch: string; id: string };

/**
 * Where the branch stands against its base and its remote, and the one button that moves it on:
 * commit, publish, push, pull, open a pull request. The rest sits in the More menu. Reads again on
 * mount, on window focus, after each action and whenever `refreshKey` changes.
 */
const DETAIL_CODES = new Set(["git", "push_rejected", "gh_failed", "draft_failed"]);

export function ShipBar(props: {
  api: Api;
  // The worktree's path.
  worktree: string;
  // Files left checked in the change list.
  checked: number;
  prs: PrStore;
  onCommit(): void;
  // After an action that moved the branch.
  onChanged(): void;
  refreshKey?: number;
}): JSX.Element {
  const { api, worktree, prs } = props;
  const { t } = useI18n();
  const [ship, setShip] = useState<ShipView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [listed, setListed] = useState(false);
  const [force, setForce] = useState<Force | null>(null);
  const [creating, setCreating] = useState(false);
  // Only the newest read may write.
  const reads = useRef(0);
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;

  useSyncExternalStore(useCallback((fn: () => void) => prs.subscribe(fn), [prs]), () => prs.snapshot(), () => prs.snapshot());
  const entry = prs.get(worktree);
  const pr: PrView | null | undefined = entry === undefined || entry.error ? undefined : entry.pr;

  async function refresh(): Promise<void> {
    const seq = ++reads.current;
    try {
      const view = await api.worktreeShip(worktree);
      if (seq === reads.current) {
        setShip(view);
        setError(null);
      }
    } catch (e) {
      if (seq === reads.current) setError(toApiError(e));
    }
  }

  useEffect(() => {
    void refresh();
    const again = () => {
      void refresh();
      void prs.load(worktree);
    };
    window.addEventListener("focus", again);
    return () => {
      window.removeEventListener("focus", again);
      reads.current++;
    };
  }, [api, worktree, prs, props.refreshKey]);

  useEffect(() => {
    void prs.load(worktree);
  }, [prs, worktree]);

  // Runs one action; its answer is the new state of the branch.
  async function run(act: () => Promise<ShipView | void>): Promise<void> {
    setBusy(true);
    setMenu(false);
    setError(null);
    try {
      const view = await act();
      if (view) {
        reads.current++;
        setShip(view);
      } else {
        await refresh();
      }
      onChanged.current();
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  function askForce(): void {
    const up = ship?.upstream;
    if (!up || up.id === null) return;
    setMenu(false);
    setForce({ remote: up.remote, branch: up.branch, id: up.id });
  }

  const action = shipAction({ checked: props.checked, ship, pr });
  const range = ship?.range ?? null;
  const up = ship?.upstream ?? null;
  const base = ship ? (ship.remote && ship.base.startsWith(`${ship.remote}/`) ? ship.base.slice(ship.remote.length + 1) : ship.base) : "";

  function main(): void {
    if (action === "commit") props.onCommit();
    else if (action === "publish" || action === "push") void run(() => api.worktreePush(worktree));
    else if (action === "pull") void run(() => api.worktreePull(worktree));
    else if (action === "create_pr") setCreating(true);
    else if (action === "open_pr") void run(() => api.worktreePrOpen(worktree, false));
  }

  return (
    <section className="ws-ship" aria-label={t("ship.region")}>
      {ship && ship.branch !== null && (
        <div className="ws-ship-info">
          <div className="ws-ship-row">
            <span className="ws-ship-branch ws-mono" title={ship.branch}>
              {t("ship.branchRow", { branch: ship.branch, base })}
            </span>
            {range && (
              <span className="ws-ship-counts ws-mono">
                {t("ship.counts", { added: range.added, removed: range.removed })}
              </span>
            )}
            {range && range.commits.length > 0 && (
              <button
                type="button"
                className="ws-ship-commits"
                aria-expanded={listed}
                title={listed ? t("ship.commits.hide") : t("ship.commits.show")}
                onClick={() => setListed((v) => !v)}
              >
                {t("ship.commits", { count: range.commits.length })}
              </button>
            )}
          </div>
          {listed && range && (
            <ul className="ws-ship-list">
              {range.commits.map((c) => (
                <li key={c.id} className="ws-ship-commit">
                  <span className="ws-ship-id ws-mono">{c.id.slice(0, SHORT)}</span>
                  <span className="ws-ship-subject">{c.message}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="ws-ship-upstream ws-mono">
            {up ? t("ship.upstream.state", { ahead: up.ahead, behind: up.behind }) : t("ship.upstream.none")}
            {pr && <span className="ws-ship-pr">{t("ship.pr.label", { number: pr.number })}</span>}
          </div>
        </div>
      )}
      <div className="ws-ship-actions">
        <Button type="button" disabled={busy || action === "none" || action === "diverged"} onClick={main}>
          {t(`ship.action.${action}`)}
        </Button>
        <button
          type="button"
          className="btn-secondary"
          aria-haspopup="menu"
          aria-expanded={menu}
          disabled={busy}
          onClick={() => setMenu((v) => !v)}
        >
          {t("ship.more")}
        </button>
      </div>
      {menu && (
        <div className="ws-ship-menu" role="menu">
          <button type="button" role="menuitem" className="ws-ship-item" onClick={() => void run(() => api.worktreePull(worktree))}>
            {t("ship.more.pull")}
          </button>
          <button type="button" role="menuitem" className="ws-ship-item" onClick={() => void run(() => api.worktreeSync(worktree))}>
            {t("ship.more.sync")}
          </button>
          <button type="button" role="menuitem" className="ws-ship-item" onClick={() => void run(() => api.worktreeFetch(worktree))}>
            {t("ship.more.fetch")}
          </button>
          <button type="button" role="menuitem" className="ws-ship-item" disabled={!up || up.id === null} onClick={askForce}>
            {t("ship.more.force")}
          </button>
        </div>
      )}
      {action === "diverged" && (
        <p className="ws-ship-note" role="status">
          {t("ship.diverged.note")}
          {up && up.id !== null && (
            <>
              {" "}
              <button type="button" className="ws-ship-link" onClick={askForce}>
                {t("ship.diverged.force")}
              </button>
            </>
          )}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error.code}`)}
          {DETAIL_CODES.has(error.code) && error.detail ? ` ${error.detail}` : ""}
        </p>
      )}
      <ConfirmDialog
        open={force !== null}
        title={t("ship.force.title")}
        body={
          force
            ? t("ship.force.body", { remote: force.remote, branch: force.branch, id: force.id.slice(0, SHORT) })
            : ""
        }
        confirmLabel={t("ship.force.confirm")}
        onConfirm={() => {
          const asked = force;
          setForce(null);
          if (asked) void run(() => api.worktreeForcePush(worktree, asked.id, true));
        }}
        onCancel={() => setForce(null)}
      />
      {creating && (
        <CreatePrDialog
          api={api}
          worktree={worktree}
          initial={{ base, title: "", body: "", draft: false }}
          onCreated={(created) => {
            setCreating(false);
            prs.set(worktree, created);
            onChanged.current();
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </section>
  );
}
