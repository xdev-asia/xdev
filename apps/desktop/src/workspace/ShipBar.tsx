import { Button, DiffStat, Popover } from "@xdev-asia/ui";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type GitSettings, type PrView, type ShipView } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { DEFAULT_GIT_SETTINGS } from "@/settings/gitDefaults";
import { CreatePrDialog } from "./CreatePrDialog";
import type { PrStore } from "./prs";
import { PULL_POLICY_CODES, PullPolicyNotice } from "./PullPolicyNotice";
import { shipAction } from "./ship";
import { breakdownRows, countsAria } from "./shipBreakdown";
import { shipMenu, type MenuId, type Text } from "./shipMenu";

const SHORT = 7;

// What a force push was asked about, kept from the moment the person saw it.
type Force = { remote: string; branch: string; id: string };

/**
 * Where the branch stands against its base and its remote, and the one button that moves it on:
 * commit, publish, push, pull, open a pull request. The rest sits in the More menu. Reads again on
 * mount, on window focus, after each action and whenever `refreshKey` changes.
 */
const DETAIL_CODES = new Set(["git", "push_rejected", "gh_failed", "draft_failed"]);
const POLICY_CODES = new Set(["needs_approval", "denied"]);

type UpdateOp = "fast-forward" | "rebase";

// The words for a failed update: the ones that name the operation read better than the generic line.
const UPDATE_LINES: Record<string, Partial<Record<UpdateOp, string>>> = {
  update_dirty: { rebase: "ship.update.dirty.rebase", "fast-forward": "ship.update.dirty.fastForward" },
  update_untracked: { rebase: "ship.update.untracked.rebase", "fast-forward": "ship.update.untracked.fastForward" },
  update_conflicts: { rebase: "ship.update.conflicts.rebase" },
  update_conflicted: { rebase: "ship.update.conflicted.rebase" },
  git: { rebase: "ship.update.failed.rebase", "fast-forward": "ship.update.failed.fastForward" },
};

function errorText(error: ApiError, op: UpdateOp | null, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const key = op ? UPDATE_LINES[error.code]?.[op] : undefined;
  if (key) return t(key, { detail: error.detail ?? "" }).trim();
  return DETAIL_CODES.has(error.code) && error.detail ? `${t(`error.${error.code}`)} ${error.detail}` : t(`error.${error.code}`);
}

// What the agent is given of a failed push: git's own words when there are any.
function pushOutput(error: ApiError, message: string): string {
  return error.detail ? `${message}\n${error.detail}` : message;
}

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
  // Settings → Git: the agent actions and the pull request defaults.
  git?: GitSettings;
  // Gives a failed push's output to an agent, as the Fix push failure recipe says; without it the
  // button is not offered.
  onFixPush?(output: string, branch: string): void;
  // Where a draft's agent problem links to: Settings → Git.
  onOpenGitSettings?(): void;
  // The commit box has text. The Commit & … entries need it.
  hasMessage?: boolean;
  // Commits (or amends) the checked files as the Commit button does; true when a commit was made.
  // The Commit & … entries stop when it is false.
  onCommitFirst?(): Promise<boolean>;
  // The base ref the bar compares against, whenever it changes.
  onBase?(base: string): void;
}): JSX.Element {
  const { api, worktree, prs } = props;
  const git = props.git ?? DEFAULT_GIT_SETTINGS;
  const { t } = useI18n();
  const [ship, setShip] = useState<ShipView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [listed, setListed] = useState(false);
  // The Code breakdown popover on the line counts.
  const [breakdown, setBreakdown] = useState(false);
  const [force, setForce] = useState<Force | null>(null);
  const [creating, setCreating] = useState(false);
  // The error on show came from a push, the one action a recipe can fix.
  const [pushFailed, setPushFailed] = useState(false);
  // The update the error on show came from, so its text can name it.
  const [op, setOp] = useState<UpdateOp | null>(null);
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

  const shipBase = ship?.base;
  useEffect(() => {
    if (shipBase !== undefined) props.onBase?.(shipBase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipBase]);

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
  async function run(act: () => Promise<ShipView | void>, push = false, update: UpdateOp | null = null): Promise<boolean> {
    setBusy(true);
    setMenu(false);
    setError(null);
    setPushFailed(false);
    setOp(update);
    try {
      const view = await act();
      if (view) {
        reads.current++;
        setShip(view);
      } else {
        await refresh();
      }
      onChanged.current();
      return true;
    } catch (e) {
      const failure = toApiError(e);
      // The commits were rewritten after they were pushed: only a force push publishes them.
      if (failure.code === "needs_force" && ship?.upstream?.id) askForce();
      else {
        setError(failure);
        setPushFailed(push);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Commits first, then the follow-up; a commit that fails or is not made stops there. The commit
  // is never rolled back.
  async function commitThen(next: () => void | Promise<unknown>): Promise<void> {
    setMenu(false);
    if (!props.onCommitFirst) return;
    setBusy(true);
    let made = false;
    try {
      made = await props.onCommitFirst();
    } finally {
      setBusy(false);
    }
    if (made) await next();
  }

  function choose(id: MenuId): void {
    if (id === "pull") void run(() => api.worktreePull(worktree));
    else if (id === "sync") void run(() => api.worktreeSync(worktree));
    else if (id === "fetch") void run(() => api.worktreeFetch(worktree));
    else if (id === "force") askForce();
    else if (id === "fast_forward") void run(() => api.worktreeFastForward(worktree), false, "fast-forward");
    else if (id === "rebase") void run(() => api.worktreeRebaseFromBase(worktree), false, "rebase");
    else if (id === "commit_push") void commitThen(() => (ship?.upstream?.rewritten ? askForce() : run(() => api.worktreePush(worktree), true)));
    else if (id === "commit_sync") void commitThen(() => run(() => api.worktreeSync(worktree)));
    else if (id === "push_then_pr") void run(() => api.worktreePush(worktree), true).then((ok) => ok && setCreating(true));
  }

  function askForce(): void {
    const up = ship?.upstream;
    if (!up || up.id === null) return;
    setMenu(false);
    setForce({ remote: up.remote, branch: up.branch, id: up.id });
  }

  const action = shipAction({ checked: props.checked, ship, pr, policy: git.pullPolicy });
  const entries = shipMenu({
    ship,
    action,
    checked: props.checked,
    hasMessage: props.hasMessage ?? false,
    busy,
    baseRemote: ship !== null && ship.remote !== null && ship.base.startsWith(`${ship.remote}/`),
    hasPr: pr != null && (pr.state === "open" || pr.state === "draft"),
  });
  const say = (x: Text) => t(x.key, x.params);
  const range = ship?.range ?? null;
  const up = ship?.upstream ?? null;
  const base = ship ? (ship.remote && ship.base.startsWith(`${ship.remote}/`) ? ship.base.slice(ship.remote.length + 1) : ship.base) : "";

  function main(): void {
    if (action === "commit") props.onCommit();
    else if (action === "publish" || action === "push") void run(() => api.worktreePush(worktree), true);
    else if (action === "pull") void run(() => api.worktreePull(worktree));
    else if (action === "create_pr") setCreating(true);
    else if (action === "open_pr") void run(() => api.worktreePrOpen(worktree, false));
  }

  // A policy stop is not something an agent can fix.
  const fixable = error !== null && pushFailed && git.sourceControlAi && props.onFixPush !== undefined && !POLICY_CODES.has(error.code);

  return (
    <section className="ws-ship" aria-label={t("ship.region")}>
      {ship && ship.branch !== null && (
        <div className="ws-ship-info">
          <div className="ws-ship-row">
            <span className="ws-ship-branch ws-mono" title={ship.branch}>
              {t("ship.branchRow", { branch: ship.branch, base })}
            </span>
            {range && (
              <Popover
                open={breakdown}
                onClose={() => setBreakdown(false)}
                label={t("ship.breakdown.title")}
                className="ws-ship-breakdown"
                placement="bottom-end"
                trigger={(pop) => (
                  <button type="button" className="ws-ship-counts ws-ship-counts-button ws-mono" {...pop} aria-label={countsAria(range, t)} onClick={() => setBreakdown((v) => !v)}>
                    {t("ship.counts", { added: range.added, removed: range.removed })}
                  </button>
                )}
              >
                <div className="ws-ship-breakdown-head">
                  <span className="ws-ship-breakdown-title">{t("ship.breakdown.title")}</span>
                  <span className="ws-ship-breakdown-sub">{t("ship.breakdown.subtitle")}</span>
                </div>
                <ul className="ws-ship-breakdown-rows">
                  {breakdownRows(range).map((row) => (
                    <li key={row.id} className="ws-ship-breakdown-row">
                      <span>{t(row.label)}</span>
                      <DiffStat
                        added={row.added}
                        removed={row.removed}
                        labels={{ diffStat: (added, removed) => t("ship.breakdown.row", { label: t(row.label), added, removed }) }}
                      />
                    </li>
                  ))}
                </ul>
              </Popover>
            )}
            {range && ship.rangeBase !== ship.base && (
              <span className="ws-ship-counts ws-mono" data-range-base={ship.rangeBase}>
                {t("ship.rangeVs", { ref: ship.rangeBase })}
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
        {/* The Changes surface already has its primary, the Commit button; this one is secondary so the surface keeps one. */}
        <Button type="button" variant="secondary" disabled={busy || action === "none" || action === "diverged"} onClick={main}>
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
          {entries.map((e, i) =>
            e.separator ? (
              <hr key={`sep${i}`} className="ws-ship-sep" />
            ) : (
              <button key={e.id} type="button" role="menuitem" className="ws-ship-item" disabled={e.disabled} title={e.tooltip ? say(e.tooltip) : undefined} onClick={() => choose(e.id)}>
                {say(e.label)}
              </button>
            ),
          )}
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
      {error && PULL_POLICY_CODES.has(error.code) && <PullPolicyNotice onOpenGitSettings={props.onOpenGitSettings} />}
      {error && !PULL_POLICY_CODES.has(error.code) && (
        <p className="error-text" role="alert">
          {errorText(error, op, t)}
          {fixable && (
            <>
              {" "}
              <button type="button" className="ws-ship-link" data-fix="push" onClick={() => props.onFixPush?.(pushOutput(error, t(`error.${error.code}`)), ship?.branch ?? "")}>
                {t("ship.push.fix")}
              </button>
            </>
          )}
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
          initial={{ base, title: "", body: "", draft: git.prDraft }}
          ai={git.sourceControlAi}
          generateOnOpen={git.sourceControlAi && git.prGenerateOnOpen}
          openAfterCreate={git.prOpenAfterCreate}
          onOpenGitSettings={props.onOpenGitSettings}
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
