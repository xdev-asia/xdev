import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type Check } from "@/api";
import { useI18n } from "@/i18n";
import { Menu } from "@xdev-asia/ui";
import { ChecksTriage } from "./ChecksTriage";
import { PrComments } from "./PrCommentList";
import { PrMergeMenu } from "./PrMergeMenu";
import { POLL_BASE_MS, canRerunUnsuccessful, nextDelay, shouldPoll, type PollOutcome } from "./checksPolicy";
import type { PrCommentStore } from "./prCommentStore";
import type { SendOutcome } from "./PrSendBar";
import type { SendChoice } from "./agentPrompt";
import type { CommentGroup } from "./prComments";
import type { Sessions } from "./sessions";
import { withOverride } from "./prComments";
import type { PrStore } from "./prs";

const REASONS: readonly string[] = ["gh_missing", "gh_auth", "not_github"];

/** The pull request of a worktree and its checks. */
export function ChecksPanel(props: {
  api: Api;
  worktree: string;
  prs: PrStore;
  // The review comments under the checks. Left out, the section does not show.
  comments?: PrCommentStore;
  visible: boolean;
  // Embedded under the pull request panel, which has its own header, merge controls and comments.
  bare?: boolean;
  // Embedded in the pull request page, which has its own header: the merge menu and comments stay.
  headless?: boolean;
  // Where queued comments can go: the sessions to pick an agent tab from, and the send itself.
  sessions?: Sessions | null;
  onSendComments?(pr: { number: number; title: string; url: string }, groups: CommentGroup[], choice: SendChoice, ack: boolean): Promise<SendOutcome>;
  // Hands a failed check to an agent (Fix checks recipe). The action shows on failed rows while
  // Settings → Git shows the agent actions; it waits for the returned promise.
  onFix?(check: Check): void | Promise<void>;
  // Hands every failing check to an agent at once, from the strip above the list.
  onFixAll?(checks: Check[]): void | Promise<void>;
}): JSX.Element {
  const { api, worktree, prs, visible } = props;
  const { t } = useI18n();
  const [openError, setOpenError] = useState<ApiError | null>(null);
  const [ai, setAi] = useState(false);
  // Logins Settings → Git marks as bots, kept here so the chips and rows agree with it.
  const [overrides, setOverrides] = useState<string[]>([]);
  // The row whose fix is being prepared.
  const [fixing, setFixing] = useState<string | null>(null);
  // The rerun menu, whether a rerun is in flight, and what the last one said.
  const [rerunMenu, setRerunMenu] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [rerunNote, setRerunNote] = useState<{ error: boolean; text: string } | null>(null);
  const [windowVisible, setWindowVisible] = useState(true);

  useSyncExternalStore(useCallback((fn: () => void) => prs.subscribe(fn), [prs]), () => prs.snapshot(), () => prs.snapshot());
  const entry = prs.get(worktree);
  const pr = entry?.pr ?? null;
  const checks = entry?.checks ?? [];
  const error = openError ?? entry?.error ?? null;

  useEffect(() => {
    setOpenError(null);
    void prs.load(worktree, { checks: true });
    const again = () => void prs.load(worktree, { checks: true });
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [prs, worktree]);

  // Read when the tab comes to the front, so a change in Settings shows without a restart.
  useEffect(() => {
    if (!visible) return;
    api.gitSettings().then(
      (git) => {
        setAi(git.sourceControlAi);
        setOverrides(git.prBotAuthorOverrides);
      },
      () => setAi(false),
    );
  }, [api, visible]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    const sync = () => setWindowVisible(document.visibilityState !== "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // Read again while the tab and the window are in front: every minute while checks change, every
  // two when they do not, and further apart while reads fail (see checksPolicy).
  const polling = shouldPoll({ panelVisible: visible, windowVisible });
  useEffect(() => {
    if (!polling) return;
    let delay = POLL_BASE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const signature = () => JSON.stringify([prs.get(worktree)?.pr, prs.get(worktree)?.checks]);
    const tick = async () => {
      const before = signature();
      await prs.load(worktree, { checks: true });
      if (stopped) return;
      const outcome: PollOutcome = prs.get(worktree)?.error ? "error" : signature() !== before ? "changed" : "same";
      delay = nextDelay(delay, outcome);
      timer = setTimeout(() => void tick(), delay);
    };
    timer = setTimeout(() => void tick(), delay);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [prs, worktree, polling]);

  // Writes the mark to Settings → Git and shows what was stored, so a refused write cannot leave a
  // chip that disagrees with the file.
  async function markBot(login: string, mark: boolean): Promise<void> {
    try {
      const git = await api.gitSettings();
      const stored = await api.setGitSettings({ ...git, prBotAuthorOverrides: withOverride(git.prBotAuthorOverrides, login, mark) });
      setOverrides(stored.prBotAuthorOverrides);
    } catch (e) {
      setOpenError(toApiError(e));
    }
  }

  async function rerun(failedOnly: boolean): Promise<void> {
    if (!pr || rerunning) return;
    setRerunMenu(false);
    setRerunning(true);
    setRerunNote(null);
    try {
      const report = await api.worktreePrChecksRerun(worktree, pr.number, failedOnly);
      const started = t(report.started === 1 ? "checks.rerun.done.one" : "checks.rerun.done", { count: report.started });
      const skipped = report.skipped > 0 ? ` ${t(report.skipped === 1 ? "checks.rerun.skipped.one" : "checks.rerun.skipped", { count: report.skipped })}` : "";
      setRerunNote({ error: false, text: started + skipped });
      void prs.load(worktree, { checks: true });
    } catch (e) {
      const err = toApiError(e);
      setRerunNote({ error: true, text: `${t(`error.${err.code}`)}${err.code === "gh_failed" && err.detail ? ` ${err.detail}` : ""}` });
    } finally {
      setRerunning(false);
    }
  }

  async function open(onChecks: boolean): Promise<void> {
    try {
      await api.worktreePrOpen(worktree, onChecks);
      setOpenError(null);
    } catch (e) {
      setOpenError(toApiError(e));
    }
  }

  return (
    <div className="ws-checks">
      {error && (
        <p className="error-text" role="alert">
          {REASONS.includes(error.code) ? t(`checks.reason.${error.code}`) : t(`error.${error.code}`)}
          {error.code === "gh_failed" && error.detail ? ` ${error.detail}` : ""}
        </p>
      )}
      {pr ? (
        <>
          {!props.bare && !props.headless && <div className="ws-checks-pr">
            <span className="ws-dot" data-pr={pr.state} aria-hidden="true" />
            <span className="ws-checks-number">{`#${pr.number}`}</span>
            <span className="ws-checks-title" title={pr.title}>
              {pr.title}
            </span>
            <span className="ws-checks-state">{t(`checks.state.${pr.state}`)}</span>
          </div>}
          <div className="ws-checks-actions">
            {!props.bare && !props.headless && (
              <button type="button" className="ws-checks-btn" onClick={() => void open(false)}>
                {t("checks.openPr")}
              </button>
            )}
            <button type="button" className="ws-checks-btn" onClick={() => void open(true)}>
              {t("checks.openChecks")}
            </button>
            <span className="ws-prc-more">
              <button type="button" className="ws-checks-btn" aria-haspopup="menu" aria-expanded={rerunMenu} disabled={rerunning || checks.length === 0} onClick={() => setRerunMenu(!rerunMenu)}>
                {t("checks.rerun")}
              </button>
              {rerunMenu && (
                <Menu
                  label={t("checks.rerun.menu")}
                  items={[
                    { label: t("checks.rerun.all"), onSelect: () => void rerun(false) },
                    { label: t("checks.rerun.failed"), disabled: !canRerunUnsuccessful(checks), onSelect: () => void rerun(true) },
                  ]}
                />
              )}
            </span>
          </div>
          {rerunNote && (
            <p className={rerunNote.error ? "error-text" : "ws-empty"} role={rerunNote.error ? "alert" : "status"}>
              {rerunNote.text}
            </p>
          )}
          <ChecksTriage checks={checks} fixing={fixing !== null} onFix={ai && props.onFixAll ? (list) => {
            setFixing("*");
            void Promise.resolve(props.onFixAll?.(list)).finally(() => setFixing(null));
          } : undefined} />
          {checks.length === 0 ? (
            <p className="ws-empty">{t("checks.none")}</p>
          ) : (
            <ul className="ws-checks-list">
              {checks.map((c, i) => (
                <li key={`${c.workflow ?? ""}/${c.name}/${i}`} className="ws-check" data-bucket={c.bucket}>
                  <span className={c.bucket === "pending" ? "ws-dot ws-pulse" : "ws-dot"} data-check={c.bucket} role="img" aria-label={t(`checks.bucket.${c.bucket}`)} title={t(`checks.bucket.${c.bucket}`)} />
                  <span className="ws-check-name" title={c.name}>
                    {c.name}
                  </span>
                  {c.workflow && <span className="ws-check-workflow">{c.workflow}</span>}
                  {c.bucket === "fail" && ai && props.onFix && (
                    <button
                      type="button"
                      className="ws-checks-btn ws-check-fix"
                      data-fix={c.name}
                      disabled={fixing !== null}
                      onClick={() => {
                        setFixing(c.name);
                        void Promise.resolve(props.onFix?.(c)).finally(() => setFixing(null));
                      }}
                    >
                      {t("checks.fix")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!props.bare && <PrMergeMenu api={api} worktree={worktree} pr={pr} prs={prs} reloadKey={entry?.checks} />}
          {!props.bare && props.comments && (
            <PrComments store={props.comments} worktree={worktree} number={pr.number} overrides={overrides} reloadKey={entry?.checks} onMarkBot={(login, mark) => void markBot(login, mark)} agent={props.onSendComments ? { sessions: props.sessions, send: (groups, choice, ack) => props.onSendComments!(pr, groups, choice, ack) } : undefined} />
          )}
        </>
      ) : (
        !error && entry && <p className="ws-empty">{t("checks.noPr")}</p>
      )}
    </div>
  );
}
