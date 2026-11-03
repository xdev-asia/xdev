import { useCallback, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { PTY_PROFILES, type Api, type ApiError, type PtyProfile } from "../api";
import { useI18n } from "../i18n";
import { Terminal } from "../terminal/Terminal";
import { useApprovedStart } from "../terminal/useApprovedStart";
import type { Sessions, Tab } from "./sessions";
import type { TabStatus } from "./status";

const GLYPH: Record<TabStatus, string> = { working: "●", idle: "○", failed: "✕", exited: "–" };

const ended = (status: TabStatus) => status === "failed" || status === "exited";

/**
 * The terminal tabs of one worktree. Every tab stays mounted while it is open, hidden when
 * another one shows, so switching never stops a pty. The shell keeps one of these per visited
 * worktree and hides the ones not selected.
 */
export function WorktreeTabs(props: { api: Api; sessions: Sessions; worktree: string; visible: boolean }): JSX.Element {
  const { api, sessions, worktree, visible } = props;
  const { t } = useI18n();
  const [active, setActive] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  // Views started per tab; a retry after approval mounts a fresh view on the same pty id.
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const { ask, error, setError, dialog } = useApprovedStart(api);

  const subscribe = useCallback((listener: () => void) => sessions.subscribe(listener), [sessions]);
  const snapshot = () => sessions.tabs(worktree);
  const tabs = useSyncExternalStore(subscribe, snapshot, snapshot);
  // A closed tab hands the view to the newest one.
  const shown = tabs.some((tab) => tab.id === active) ? active : (tabs[tabs.length - 1]?.id ?? null);

  const name = (tab: Tab) => t(`terminal.profile.${tab.profileId}`);

  function launch(profile: PtyProfile): void {
    setMenu(false);
    setError(null);
    setActive(sessions.open(worktree, profile).id);
  }

  function failed(tab: Tab, e: ApiError): void {
    const tries = attempts[tab.id] ?? 0;
    ask(
      tab.profileId,
      e,
      tries > 0,
      () => setAttempts((a) => ({ ...a, [tab.id]: (a[tab.id] ?? 0) + 1 })),
      // A tab whose pty never started has nothing to show; the reason stays in the banner.
      () => void sessions.close(tab.id),
    );
  }

  function again(tab: Tab): void {
    setError(null);
    const next = sessions.restart(tab.id);
    if (next) setActive(next.id);
  }

  return (
    <div className="ws-tabs" hidden={!visible}>
      <div className="ws-tabstrip">
        <div className="ws-tablist" role="tablist" aria-label={t("workspace.tabs.label")}>
          {tabs.map((tab) => (
            <div key={tab.id} className="ws-tab" data-selected={tab.id === shown}>
              <button
                type="button"
                role="tab"
                className="ws-tab-main"
                data-tab={tab.id}
                aria-selected={tab.id === shown}
                onClick={() => setActive(tab.id)}
              >
                <span className="ws-tab-icon ws-mono" aria-hidden="true">
                  {">_"}
                </span>
                <span>{name(tab)}</span>
                <span
                  className={tab.status === "working" ? "ws-tab-glyph ws-pulse" : "ws-tab-glyph"}
                  data-status={tab.status}
                  role="img"
                  aria-label={t(`workspace.tabs.status.${tab.status}`)}
                  title={t(`workspace.tabs.status.${tab.status}`)}
                >
                  {GLYPH[tab.status]}
                </span>
              </button>
              <button
                type="button"
                className="ws-tab-close"
                aria-label={t("workspace.tabs.close", { name: name(tab) })}
                title={t("workspace.tabs.close", { name: name(tab) })}
                onClick={() => void sessions.close(tab.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="ws-tab-add">
          <button
            type="button"
            className="ws-icon-btn"
            aria-label={t("workspace.tabs.new")}
            title={t("workspace.tabs.new")}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          {menu && (
            <>
              <div className="ws-menu-backdrop" onClick={() => setMenu(false)} />
              <div className="ws-menu" role="menu">
                {PTY_PROFILES.map((p) => (
                  <button key={p} type="button" role="menuitem" onClick={() => launch(p)}>
                    {t(`terminal.profile.${p}`)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="banner banner-warn ws-tabs-banner" role="alert">
          <div className="banner-text">
            <span>{t(`error.${error.code}`)}</span>
            {error.detail && <pre className="commands">{error.detail}</pre>}
          </div>
        </div>
      )}

      {tabs.map((tab) => (
        <div key={tab.id} className="ws-tab-pane" role="tabpanel" data-tab={tab.id} hidden={tab.id !== shown}>
          {ended(tab.status) && (
            <div className="ws-tab-exit" role="status">
              <span>
                {tab.exitCode === null || tab.exitCode === undefined
                  ? t("terminal.exitedUnknown")
                  : t("terminal.exited", { code: tab.exitCode })}
              </span>
              <button type="button" className="ws-tab-again" onClick={() => again(tab)}>
                {t("workspace.tabs.again")}
              </button>
            </div>
          )}
          <Terminal
            key={`${tab.id}:${attempts[tab.id] ?? 0}`}
            api={api}
            client={tab.client}
            id={tab.id}
            cwd={worktree}
            profile={tab.profileId}
            onStarted={() => {}}
            onError={(e) => failed(tab, e)}
            onOutput={(bytes) => sessions.noteOutput(tab.id, bytes)}
            onInput={() => sessions.noteInput(tab.id)}
          />
        </div>
      ))}

      {tabs.length === 0 && (
        <div className="ws-center-empty">
          <p>{t("workspace.tabs.empty")}</p>
          <div className="ws-launch">
            {PTY_PROFILES.map((p) => (
              <button key={p} type="button" className="btn-secondary" onClick={() => launch(p)}>
                {t(`terminal.profile.${p}`)}
              </button>
            ))}
          </div>
        </div>
      )}
      {dialog}
    </div>
  );
}
