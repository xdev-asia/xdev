import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { profileName, useProfiles } from "@/agents/profileStore";
import { type Api, type ApiError, type PtyProfile } from "@/api";
import { useI18n } from "@/i18n";
import { Terminal } from "@/terminal/Terminal";
import { useApprovedStart } from "@/terminal/useApprovedStart";
import { AgentIcon } from "./AgentIcon";
import { cliOf, type Sessions, type Split, type Tab, type TabCli } from "./sessions";
import type { TabStatus } from "./status";
import { StatusGlyph } from "./StatusGlyph";
import { titleStatus } from "./titles";
import { WorktreeDiff } from "./WorktreeDiff";

// Offered while the profile view has not loaded: the built-in agents and the default shell.
const FALLBACK_AGENTS: readonly PtyProfile[] = ["claude", "codex"];
const FALLBACK_SHELL: PtyProfile = "shell";


const ended = (status: TabStatus) => status === "failed" || status === "exited";

// A diff tab's id; terminal tabs use their pty id, which never has a colon.
const fileTab = (file: string) => `file:${file}`;
const base = (file: string) => file.slice(file.lastIndexOf("/") + 1);

/** The terminal that shows beside the one at `at`: the split's second, or a neighbour when that one is in front. */
function partnerOf(tabs: Tab[], at: number, split: NonNullable<Split>): string | null {
  const second = tabs.find((tab) => tab.id === split.second);
  if (!second) return null;
  if (second.id !== tabs[at].id) return second.id;
  return (tabs[at - 1] ?? tabs[at + 1])?.id ?? null;
}

/** A file to show as a diff tab; a new `seq` opens it again, read afresh. */
export type Reveal = { file: string; seq: number };

/**
 * The terminal tabs of one worktree. Every tab stays mounted while it is open, hidden when
 * another one shows, so switching never stops a pty. The shell keeps one of these per visited
 * worktree and hides the ones not selected. Diff tabs of the worktree's files sit after the
 * terminals.
 */
export function WorktreeTabs(props: {
  api: Api;
  sessions: Sessions;
  worktree: string;
  visible: boolean;
  reveal?: Reveal;
  /** Brings a terminal tab to the front; a new `seq` is a new request. */
  front?: { id: string; seq: number };
  /** Told which tab is in front, so the shell knows where a prompt from the Agent kit goes. */
  onShown?: (id: string | null) => void;
}): JSX.Element {
  const { api, sessions, worktree, visible, reveal } = props;
  const { t } = useI18n();
  const [active, setActive] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  // Views started per tab; a retry after approval mounts a fresh view on the same pty id.
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const { ask, error, setError, dialog } = useApprovedStart(api);
  // Open diff tabs; `seq` keys the view, so opening a file again reads it again.
  const [files, setFiles] = useState<Reveal[]>([]);
  const [revealed, setRevealed] = useState(0);
  const [fronted, setFronted] = useState(0);

  // Taken during render, so the frame that asks for a file already shows it.
  let open = files;
  let pick = active;
  if (reveal && reveal.seq !== revealed) {
    open = [...files.filter((f) => f.file !== reveal.file), reveal];
    pick = fileTab(reveal.file);
    setRevealed(reveal.seq);
    setFiles(open);
    setActive(pick);
  }

  if (props.front && props.front.seq !== fronted) {
    pick = props.front.id;
    setFronted(props.front.seq);
    setActive(pick);
  }

  const subscribe = useCallback((listener: () => void) => sessions.subscribe(listener), [sessions]);
  const snapshot = () => sessions.tabs(worktree);
  const tabs = useSyncExternalStore(subscribe, snapshot, snapshot);
  // A closed tab hands the view to the newest terminal, else to the newest diff.
  const ids = [...tabs.map((tab) => tab.id), ...open.map((f) => fileTab(f.file))];
  const shown = pick && ids.includes(pick) ? pick : (tabs[tabs.length - 1]?.id ?? (open.length ? fileTab(open[open.length - 1].file) : null));

  const { onShown } = props;
  useEffect(() => onShown?.(shown), [shown]);

  // The split pairs the shown terminal with one other; a diff tab in front shows alone.
  const splitSnapshot = () => sessions.split(worktree);
  const split = useSyncExternalStore(subscribe, splitSnapshot, splitSnapshot);
  const at = tabs.findIndex((tab) => tab.id === shown);
  const partner = split && at >= 0 ? partnerOf(tabs, at, split) : null;
  // Both panes of a split are visible; every other pane stays mounted and hidden.
  const visibleIds = partner ? [shown, partner] : [shown];
  const canSplit = tabs.length >= 2 && at >= 0;

  const { view } = useProfiles();
  const name = (tab: Tab) => profileName(view, tab.profileId, t);
  // What the tab strip shows: the terminal's own title once it set one, else the profile.
  const shownName = (tab: Tab) => tab.title ?? name(tab);
  const statusLabel = (status: TabStatus) => t(`workspace.tabs.status.${status}`);
  // The CLI a profile runs, from the profile view; the built-in ids stand in until it loads.
  const cliFor = (id: PtyProfile): TabCli => {
    const found = view?.profiles.find((p) => p.profile.id === id);
    if (!found) return cliOf(id);
    const cli = found.profile.cli;
    return cli === "claude" || cli === "codex" ? cli : null;
  };
  // The `+` menu: agents that are on and installed, then every shell on offer.
  const agents = view ? view.profiles.filter((p) => p.profile.enabled && p.installed).map((p) => p.profile.id) : FALLBACK_AGENTS;
  const shells = view ? view.shells.map((s) => s.id) : [FALLBACK_SHELL];
  const groups = [
    { label: t("workspace.tabs.agents"), ids: agents },
    { label: t("workspace.tabs.shells"), ids: shells },
  ].filter((g) => g.ids.length > 0);

  // Picking the second tab of a split keeps the pair: the tab that was in front takes its place.
  function select(id: string): void {
    if (split && id === split.second && shown && !shown.startsWith("file:")) sessions.setSplit(worktree, { ...split, second: shown });
    setActive(id);
  }

  function toggleSplit(dir: "right" | "down"): void {
    if (!canSplit) return;
    if (split?.dir === dir) return sessions.setSplit(worktree, null);
    // Keep the tab already beside this one when only the direction changes.
    const second = partner ?? tabs[at + 1 < tabs.length ? at + 1 : at - 1].id;
    sessions.setSplit(worktree, { dir, second });
  }

  function launch(profile: PtyProfile): void {
    setMenu(false);
    setError(null);
    setActive(sessions.open(worktree, profile, null, cliFor(profile)).id);
  }

  // Ctrl+Alt+T opens the default agent, in the worktree on screen only. Taken in the capture
  // phase so the terminal under focus does not also get the key.
  const defaultAgent = view?.defaultAgent ?? FALLBACK_AGENTS[0];
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return;
      if (e.code !== "KeyT" && e.key.toLowerCase() !== "t") return;
      e.preventDefault();
      e.stopPropagation();
      launch(defaultAgent);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, defaultAgent, sessions, worktree]);

  function failed(tab: Tab, e: ApiError): void {
    const tries = attempts[tab.id] ?? 0;
    ask(
      tab.profileId,
      e,
      tries > 0,
      () => setAttempts((a) => ({ ...a, [tab.id]: (a[tab.id] ?? 0) + 1 })),
      // A tab whose pty never started has nothing to show; the reason stays in the banner.
      () => void sessions.close(tab.id),
      tab.account,
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
                className={tab.unread ? "ws-tab-main ws-tab-unread" : "ws-tab-main"}
                data-tab={tab.id}
                aria-selected={tab.id === shown}
                aria-label={
                  tab.unread
                    ? t("workspace.tabs.unreadLabel", { name: shownName(tab), status: statusLabel(tab.status).toLocaleLowerCase() })
                    : undefined
                }
                title={tab.title ?? undefined}
                onClick={() => select(tab.id)}
              >
                <AgentIcon profile={tab.profileId} size={16} />
                <span className="ws-tab-name">{shownName(tab)}</span>
                {tab.permissions === "skip" && (
                  <span className="ws-tab-skip" title={t("workspace.tabs.skipHint")}>
                    <span className="ws-tab-skip-dot" aria-hidden="true" />
                    {t("workspace.tabs.skip")}
                  </span>
                )}
                {/* Plain shells are not agents: no status mark. */}
                {StatusGlyph({ status: tab.agent ? tab.status : null, label: statusLabel(tab.status) })}
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
          {open.map(({ file }) => (
            <div key={fileTab(file)} className="ws-tab" data-selected={fileTab(file) === shown}>
              <button
                type="button"
                role="tab"
                className="ws-tab-main"
                data-tab={fileTab(file)}
                aria-selected={fileTab(file) === shown}
                title={file}
                onClick={() => setActive(fileTab(file))}
              >
                <span className="ws-tab-icon ws-mono" aria-hidden="true">
                  ±
                </span>
                <span>{base(file)}</span>
              </button>
              <button
                type="button"
                className="ws-tab-close"
                aria-label={t("workspace.tabs.close", { name: base(file) })}
                title={t("workspace.tabs.close", { name: base(file) })}
                onClick={() => setFiles(open.filter((f) => f.file !== file))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="ws-tab-tools">
          {(["right", "down"] as const).map((dir) => {
            const label = t(`workspace.tabs.split.${dir}`);
            return (
              <button
                key={dir}
                type="button"
                className="ws-icon-btn"
                aria-label={label}
                title={label}
                aria-disabled={!canSplit}
                aria-pressed={split?.dir === dir}
                onClick={() => toggleSplit(dir)}
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d={dir === "right" ? "M12 4v16" : "M3 12h18"} />
                </svg>
              </button>
            );
          })}
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
                {groups.map((g) => (
                  <div key={g.label} className="ws-menu-group" role="group" aria-label={g.label}>
                    <div className="ws-menu-label" aria-hidden="true">
                      {g.label}
                    </div>
                    {g.ids.map((p) => (
                      <button key={p} type="button" role="menuitem" onClick={() => launch(p)}>
                        {profileName(view, p, t)}
                      </button>
                    ))}
                  </div>
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

      <div className="ws-panes" data-split={partner ? split?.dir : undefined}>
        {tabs.map((tab) => (
          <div key={tab.id} className="ws-tab-pane" role="tabpanel" data-tab={tab.id} hidden={!visibleIds.includes(tab.id)}>
            {ended(tab.status) && (
              <div className="ws-tab-exit" role="status">
                <span>
                  {tab.exitCode === null || tab.exitCode === undefined
                    ? t("terminal.exitedUnknown")
                    : t("terminal.exited", { code: tab.exitCode })}
                </span>
                <button type="button" className="ws-tab-again" onClick={() => again(tab)}>
                  {tab.agent ? t("workspace.tabs.restart") : t("workspace.tabs.again")}
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
              account={tab.account}
              onStarted={(info) => sessions.noteStarted(tab.id, info)}
              onError={(e) => failed(tab, e)}
              onOutput={(bytes) => sessions.noteOutput(tab.id, bytes)}
              onInput={(text) => sessions.noteInput(tab.id, text)}
              onTitle={(title) => {
                sessions.noteTitle(tab.id, title);
                const status = titleStatus(tab.cli, title);
                if (status) sessions.noteTitleStatus(tab.id, status);
              }}
            />
          </div>
        ))}

        {open.map((f) => (
          <div key={fileTab(f.file)} className="ws-tab-pane" role="tabpanel" data-tab={fileTab(f.file)} hidden={fileTab(f.file) !== shown}>
            <WorktreeDiff key={f.seq} api={api} worktree={worktree} file={f.file} />
          </div>
        ))}
      </div>

      {tabs.length === 0 && open.length === 0 && (
        <div className="ws-center-empty">
          <p>{t("workspace.tabs.empty")}</p>
          <div className="ws-launch">
            {[view?.defaultShell ?? FALLBACK_SHELL, ...agents].map((p) => (
              <button key={p} type="button" className="btn-secondary" onClick={() => launch(p)}>
                {profileName(view, p, t)}
              </button>
            ))}
          </div>
        </div>
      )}
      {dialog}
    </div>
  );
}
