import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError } from "@/api";
import { useI18n } from "@/i18n";
import type { PrStore } from "./prs";

const REFRESH_MS = 30_000;
const REASONS: readonly string[] = ["gh_missing", "gh_auth", "not_github"];

/** The pull request of a worktree and its checks. */
export function ChecksPanel(props: { api: Api; worktree: string; prs: PrStore; visible: boolean }): JSX.Element {
  const { api, worktree, prs, visible } = props;
  const { t } = useI18n();
  const [openError, setOpenError] = useState<ApiError | null>(null);

  useSyncExternalStore(useCallback((fn: () => void) => prs.subscribe(fn), [prs]), () => prs.snapshot(), () => prs.snapshot());
  const entry = prs.get(worktree);
  const pr = entry?.pr ?? null;
  const checks = entry?.checks ?? [];
  const pending = checks.some((c) => c.bucket === "pending");
  const error = openError ?? entry?.error ?? null;

  useEffect(() => {
    setOpenError(null);
    void prs.load(worktree, { checks: true });
    const again = () => void prs.load(worktree, { checks: true });
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [prs, worktree]);

  // Only an unfinished run, and only while the tab is in front, is worth asking about again.
  useEffect(() => {
    if (!visible || !pending) return;
    const id = setInterval(() => void prs.load(worktree, { checks: true }), REFRESH_MS);
    return () => clearInterval(id);
  }, [prs, worktree, visible, pending]);

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
          <div className="ws-checks-pr">
            <span className="ws-dot" data-pr={pr.state} aria-hidden="true" />
            <span className="ws-checks-number">{`#${pr.number}`}</span>
            <span className="ws-checks-title" title={pr.title}>
              {pr.title}
            </span>
            <span className="ws-checks-state">{t(`checks.state.${pr.state}`)}</span>
          </div>
          <div className="ws-checks-actions">
            <button type="button" className="ws-checks-btn" onClick={() => void open(false)}>
              {t("checks.openPr")}
            </button>
            <button type="button" className="ws-checks-btn" onClick={() => void open(true)}>
              {t("checks.openChecks")}
            </button>
          </div>
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
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        !error && entry && <p className="ws-empty">{t("checks.noPr")}</p>
      )}
    </div>
  );
}
