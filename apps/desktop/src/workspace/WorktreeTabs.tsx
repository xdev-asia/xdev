import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { profileName, useProfiles } from "@/agents/profileStore";
import { type Api, type ApiError, type PtyProfile } from "@/api";
import { useI18n } from "@/i18n";
import { ReviewView } from "@/review/ReviewView";
import { Terminal } from "@/terminal/Terminal";
import { useApprovedStart } from "@/terminal/useApprovedStart";
import {
  addTab,
  equalize,
  focusPane,
  leaves,
  paneOf,
  removeTab,
  resize,
  selectTab,
  single,
  splitPane,
  type PaneDir,
  type PaneLayout,
  type PaneNode,
} from "./paneTree";
import { bodyStyle, PaneView, paneRects } from "./PaneView";
import { cliOf, type Sessions, type Tab, type TabCli } from "./sessions";
import { TabStrip, type MenuGroup, type StripItem } from "./TabStrip";
import { titleStatus } from "./titles";

// Offered while the profile view has not loaded: the built-in agents and the default shell.
const FALLBACK_AGENTS: readonly PtyProfile[] = ["claude", "codex"];
const FALLBACK_SHELL: PtyProfile = "shell";

// Only an exit ends a tab; a turn that failed (status failed) still has its pty.
const ended = (tab: Tab) => tab.exitCode !== undefined;

// The review tab's id; terminal tabs use their pty id, which never has a colon.
const REVIEW_TAB = "review:";

type Leaf = Extract<PaneNode, { kind: "leaf" }>;

/** A file to show in the review tab; a new `seq` asks for it again. */
export type Reveal = { file: string; seq: number };

/**
 * The terminal tabs of one worktree, laid out as a tree of panes. Every terminal stays mounted while
 * its tab is open, in one flat list keyed by tab id: a pane only reserves the area a terminal is
 * placed in, so moving or resizing panes never remounts xterm. The shell keeps one of these per
 * visited worktree and hides the ones not selected. The review tab sits in a pane like any tab.
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
  /** Told which terminal panes are on screen (the front tab of each pane), so the shell knows what is seen. */
  onPanes?: (ids: string[]) => void;
  /** A new value puts keyboard focus in the terminal in front. */
  focusSeq?: number;
}): JSX.Element {
  const { api, sessions, worktree, visible, reveal } = props;
  const { t } = useI18n();
  // The pane whose `+` menu is open.
  const [menuPane, setMenuPane] = useState<string | null>(null);
  // Views started per tab; a retry after approval mounts a fresh view on the same pty id.
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const { ask, error, setError, dialog } = useApprovedStart(api);
  // The one review tab; a reveal opens it (or points it at another file).
  const [review, setReview] = useState<Reveal | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [fronted, setFronted] = useState(0);

  const subscribe = useCallback((listener: () => void) => sessions.subscribe(listener), [sessions]);
  const snapshot = () => sessions.tabs(worktree);
  const tabs = useSyncExternalStore(subscribe, snapshot, snapshot);
  const layoutSnapshot = () => sessions.layout(worktree);
  const stored = useSyncExternalStore(subscribe, layoutSnapshot, layoutSnapshot);

  // A reveal opens the review tab; taken during render, so the frame that asks for a file already has it.
  let open = review;
  if (reveal && reveal.seq !== revealed) {
    open = reveal;
    setRevealed(reveal.seq);
    setReview(open);
  }
  // The layout with the review tab in or out of it: the same object when nothing changes. The store
  // catches up in the effect below.
  const layout: PaneLayout | null = open
    ? stored
      ? addTab(stored, REVIEW_TAB)
      : single(REVIEW_TAB)
    : stored && paneOf(stored, REVIEW_TAB)
      ? removeTab(stored, REVIEW_TAB)
      : stored;
  useEffect(() => {
    if (layout !== stored) sessions.setLayout(worktree, layout);
  }, [layout, stored, sessions, worktree]);

  // What the shell reads: the front tab of the focused pane, and the front tab of every pane on screen.
  const rects = layout ? paneRects(layout) : {};
  const panes = layout ? (leaves(layout) as Leaf[]) : [];
  const focusedLeaf = panes.find((n) => n.id === layout?.focused);
  const shown = focusedLeaf?.active ?? null;
  const frontIds = new Set(panes.filter((n) => n.id in rects).map((n) => n.active));
  // A string, so the shell hears only when the set on screen changes.
  const paneKey = [...frontIds].filter((id) => id !== REVIEW_TAB).join(" ");
  const { onShown, onPanes, front } = props;
  useEffect(() => onShown?.(shown), [shown]);
  useEffect(() => onPanes?.(paneKey ? paneKey.split(" ") : []), [paneKey]);

  // The shell asks for a tab to come to the front, and a reveal for the review tab to.
  useEffect(() => {
    if (!front || front.seq === fronted) return;
    setFronted(front.seq);
    if (layout) sessions.setLayout(worktree, selectTab(layout, front.id));
  }, [front?.seq]);
  useEffect(() => {
    if (reveal && layout && paneOf(layout, REVIEW_TAB)) sessions.setLayout(worktree, selectTab(layout, REVIEW_TAB));
  }, [reveal?.seq]);

  const { view } = useProfiles();
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
  const groups: MenuGroup[] = [
    { label: t("workspace.tabs.agents"), ids: [...agents] },
    { label: t("workspace.tabs.shells"), ids: shells },
  ].filter((g) => g.ids.length > 0);
  const defaultShell = view?.defaultShell ?? FALLBACK_SHELL;

  const setLayout = (next: PaneLayout | null) => sessions.setLayout(worktree, next);

  // A new tab in `pane`: `open` puts it in the focused pane, so that one is focused first.
  function launch(profile: PtyProfile, pane?: string): Tab {
    setMenuPane(null);
    setError(null);
    const at = sessions.layout(worktree);
    if (pane && at && at.focused !== pane) setLayout(focusPane(at, pane));
    return sessions.open(worktree, profile, null, cliFor(profile));
  }

  // A new pane beside `pane`, with a new terminal in it.
  function splitWith(pane: string, dir: PaneDir, profile: PtyProfile): void {
    const tab = launch(profile, pane);
    const now = sessions.layout(worktree);
    const without = now && removeTab(now, tab.id);
    if (without) setLayout(splitPane(without, pane, dir, tab.id));
  }

  // Moves a tab of `pane` into a new pane beside it. The only tab of a pane has nothing to leave.
  function splitTab(pane: string, id: string, dir: PaneDir): void {
    const leaf = panes.find((n) => n.id === pane);
    if (!layout || !leaf || leaf.tabs.length < 2) return;
    const without = removeTab(layout, id);
    if (without) setLayout(splitPane(without, pane, dir, id));
  }

  function closeTab(id: string): void {
    if (id !== REVIEW_TAB) return void sessions.close(id);
    setReview(null);
    if (layout) setLayout(removeTab(layout, REVIEW_TAB));
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
    sessions.restart(tab.id);
  }

  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const stripOf = (leaf: Leaf) => {
    const items: StripItem[] = leaf.tabs.flatMap((id): StripItem[] => {
      if (id === REVIEW_TAB) return [{ id, tab: null }];
      const tab = byId.get(id);
      return tab ? [{ id, tab }] : [];
    });
    return (
      <TabStrip
        pane={leaf.id}
        items={items}
        active={leaf.active}
        groups={groups}
        menuOpen={menuPane === leaf.id}
        onMenu={(isOpen) => setMenuPane(isOpen ? leaf.id : null)}
        onSelect={(id) => layout && setLayout(selectTab(layout, id))}
        onClose={closeTab}
        onCloseOthers={(id) => {
          for (const other of leaf.tabs) if (other !== id) closeTab(other);
        }}
        onLaunch={(profile) => launch(profile, leaf.id)}
        onSplit={(dir) => splitWith(leaf.id, dir, defaultShell)}
        onSplitTab={(id, dir) => splitTab(leaf.id, id, dir)}
        onRename={(id, name) => sessions.rename(id, name)}
      />
    );
  };
  // Where a tab's view sits: the body of its pane while it is that pane's front tab, else hidden.
  const placed = (id: string): { hidden: boolean; style?: ReturnType<typeof bodyStyle> } => {
    const pane = layout ? paneOf(layout, id) : null;
    const rect = pane ? rects[pane] : undefined;
    return rect && frontIds.has(id) ? { hidden: false, style: bodyStyle(rect) } : { hidden: true };
  };
  const reviewAt = placed(REVIEW_TAB);

  return (
    <div className="ws-tabs" hidden={!visible}>
      {error && (
        <div className="banner banner-warn ws-tabs-banner" role="alert">
          <div className="banner-text">
            <span>{t(`error.${error.code}`)}</span>
            {error.detail && <pre className="commands">{error.detail}</pre>}
          </div>
        </div>
      )}

      <div className="ws-panes">
        {layout && (
          <PaneView
            layout={layout}
            strip={stripOf}
            onFocus={(pane) => layout.focused !== pane && setLayout(focusPane(layout, pane))}
            onResize={(split, sizes) => setLayout(resize(layout, split, sizes))}
            onEqualize={() => setLayout(equalize(layout))}
          />
        )}
        {tabs.map((tab) => {
          const at = placed(tab.id);
          return (
            <div
              key={tab.id}
              className="ws-tab-pane"
              role="tabpanel"
              data-tab={tab.id}
              hidden={at.hidden}
              style={at.style}
              onPointerDownCapture={() => {
                const pane = layout ? paneOf(layout, tab.id) : null;
                if (layout && pane && layout.focused !== pane) setLayout(focusPane(layout, pane));
              }}
            >
              {ended(tab) && (
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
                onBell={() => sessions.noteBell(tab.id)}
                onTitle={(title) => {
                  sessions.noteTitle(tab.id, title);
                  const status = titleStatus(tab.cli, title);
                  if (status) sessions.noteTitleStatus(tab.id, status);
                }}
                focusSeq={tab.id === shown ? props.focusSeq : undefined}
              />
            </div>
          );
        })}

        {open && (
          <div className="ws-tab-pane" role="tabpanel" data-tab={REVIEW_TAB} hidden={reviewAt.hidden} style={reviewAt.style}>
            <ReviewView api={api} worktree={worktree} sessions={sessions} reveal={open} />
          </div>
        )}
      </div>

      {tabs.length === 0 && !open && (
        <div className="ws-center-empty">
          <p>{t("workspace.tabs.empty")}</p>
          <div className="ws-launch">
            {[defaultShell, ...agents].map((p) => (
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
