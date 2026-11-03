import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { profileName, useProfiles } from "@/agents/profileStore";
import { type Api, type ApiError, type PtyProfile } from "@/api";
import { useI18n } from "@/i18n";
import { useKeymap } from "@/keys/keymap";
import { ReviewView } from "@/review/ReviewView";
import { Terminal } from "@/terminal/Terminal";
import { useApprovedStart } from "@/terminal/useApprovedStart";
import {
  addTab,
  equalize,
  focusPane,
  leaves,
  neighbour,
  paneOf,
  removeTab,
  resize,
  selectTab,
  single,
  splitPane,
  toggleExpand,
  type PaneDir,
  type PaneLayout,
  type PaneNode,
} from "./paneTree";
import { CloseTabsDialog } from "./CloseTabsDialog";
import { bodyStyle, PaneView, paneRects } from "./PaneView";
import { cliOf, type Sessions, type Tab, type TabCli } from "./sessions";
import type { SetupGate } from "./setupGate";
import { TabStrip, type MenuGroup, type StripItem } from "./TabStrip";
import { cycleTab, nthTab } from "./tabNav";
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
  /** Shows a session in the session history panel. */
  onShowHistory?: (sessionId: string) => void;
  /** Holds agent launches while this worktree's setup tab runs. */
  gate?: SetupGate;
}): JSX.Element {
  const { api, sessions, worktree, visible, reveal } = props;
  const { t } = useI18n();
  // The pane whose `+` menu is open.
  const [menuPane, setMenuPane] = useState<string | null>(null);
  // Tabs a key asked to close while an agent runs in one of them; null when nothing waits.
  const [closing, setClosing] = useState<string[] | null>(null);
  // Bumped when a key moves focus, so the terminal in front takes the keyboard.
  const [kick, setKick] = useState(0);
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
  // The default shell: the profile view's, else its first; null when none is on.
  const defaultShell: PtyProfile | null = view
    ? shells.includes(view.defaultShell)
      ? view.defaultShell
      : (shells[0] ?? null)
    : FALLBACK_SHELL;

  const setLayout = (next: PaneLayout | null) => sessions.setLayout(worktree, next);

  // A new tab in `pane`: `open` puts it in the focused pane, so that one is focused first.
  function launch(profile: PtyProfile, pane?: string): Tab {
    setMenuPane(null);
    setError(null);
    const at = sessions.layout(worktree);
    if (pane && at && at.focused !== pane) setLayout(focusPane(at, pane));
    return sessions.open(worktree, profile, null, cliFor(profile));
  }

  // An agent launch waits for the setup tab when the gate says so; a shell never does.
  function launchGated(profile: PtyProfile, pane?: string): void {
    const agent = !profile.startsWith("shell") && !profile.startsWith("xdev:");
    if (agent && props.gate?.defer(worktree, () => void launch(profile, pane))) return;
    launch(profile, pane);
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

  const byId = new Map(tabs.map((tab) => [tab.id, tab]));

  // ---- Keys: they act on the focused pane ----------------------------------------------------

  // Puts `id` in front in its pane, focuses that pane, and gives its terminal the keyboard.
  function go(id: string): void {
    if (!layout) return;
    setLayout(selectTab(layout, id));
    setKick((k) => k + 1);
  }

  // A new tab of the default shell in the focused pane; with no shell on, the `+` menu of that pane.
  function newShell(): boolean {
    if (defaultShell === null) {
      if (!layout) return false;
      setMenuPane(layout.focused);
      return true;
    }
    launch(defaultShell);
    setKick((k) => k + 1);
    return true;
  }

  function closeNow(targets: string[]): void {
    for (const id of targets) closeTab(id);
  }

  // A key closes at once, unless an agent still runs in one of the tabs.
  function requestClose(targets: string[]): boolean {
    if (targets.length === 0) return false;
    if (targets.some((id) => byId.get(id)?.agent && !ended(byId.get(id)!))) setClosing(targets);
    else closeNow(targets);
    return true;
  }

  function stepTab(step: 1 | -1): boolean {
    const to = cycleTab(focusedLeaf?.tabs ?? [], shown, step);
    if (to === null || to === shown) return false;
    go(to);
    return true;
  }

  function pickTab(n: number): boolean {
    const to = nthTab(focusedLeaf?.tabs ?? [], n);
    if (to === null) return false;
    go(to);
    return true;
  }

  function splitKey(dir: PaneDir): boolean {
    if (!layout || defaultShell === null) return false;
    splitWith(layout.focused, dir, defaultShell);
    setKick((k) => k + 1);
    return true;
  }

  // Focus moves to the next pane in reading order; an expansion follows it (focusPane does that).
  function movePane(step: 1 | -1): boolean {
    if (!layout) return false;
    const to = neighbour(layout, layout.focused, step);
    if (to === layout.focused) return false;
    setLayout(focusPane(layout, to));
    setKick((k) => k + 1);
    return true;
  }

  // Expand or equalize: taken whenever there are panes, even when nothing changes.
  function reshape(fn: (l: PaneLayout) => PaneLayout): boolean {
    if (!layout) return false;
    setLayout(fn(layout));
    return true;
  }

  // Taken in the capture phase so the terminal under focus does not also get the key. This
  // worktree listens only while it is on screen. A handler that returns false lets the key on.
  const defaultAgent = view?.defaultAgent ?? FALLBACK_AGENTS[0];
  useKeymap(
    {
      "agent.new": () => void launchGated(defaultAgent),
      "tab.new": () => newShell(),
      "tab.close": () => requestClose(shown ? [shown] : []),
      "tab.next": () => stepTab(1),
      "tab.prev": () => stepTab(-1),
      ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tab.select.${n}`, () => pickTab(n)])),
      "pane.splitRight": () => splitKey("right"),
      "pane.splitDown": () => splitKey("down"),
      "pane.next": () => movePane(1),
      "pane.prev": () => movePane(-1),
      "pane.expand": () => reshape((l) => toggleExpand(l, l.focused)),
      "pane.equalize": () => reshape(equalize),
      "pane.close": () => requestClose(focusedLeaf?.tabs ?? []),
    },
    { when: () => visible },
  );

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
      tab.resumeOf ?? undefined,
    );
  }

  function again(tab: Tab): void {
    setError(null);
    sessions.restart(tab.id);
  }

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
        onLaunch={(profile) => launchGated(profile, leaf.id)}
        onSplit={(dir) => defaultShell !== null && splitWith(leaf.id, dir, defaultShell)}
        onSplitTab={(id, dir) => splitTab(leaf.id, id, dir)}
        onRename={(id, name) => sessions.rename(id, name)}
        onShowHistory={props.onShowHistory}
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
                focusSeq={tab.id === shown ? (props.focusSeq ?? 0) + kick : undefined}
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
            {[...(defaultShell !== null ? [defaultShell] : []), ...agents].map((p) => (
              <button key={p} type="button" className="btn-secondary" onClick={() => launchGated(p)}>
                {profileName(view, p, t)}
              </button>
            ))}
          </div>
        </div>
      )}
      {dialog}
      {closing && (
        <CloseTabsDialog
          onConfirm={() => {
            closeNow(closing);
            setClosing(null);
          }}
          onCancel={() => setClosing(null)}
        />
      )}
    </div>
  );
}
