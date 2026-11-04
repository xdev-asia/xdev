import type { AccountSource, Api, HookDetail, PtyInfo, PtyProfile, RestoreMode } from "@/api";
import { PtyClient } from "@/terminal/ptyClient";
import { addTab, leaves, paneOf, pinFirst, removeTab, replaceTab, single, splitPane, type PaneDir, type PaneLayout } from "./paneTree";
import { LAYOUT_VERSION, fromSnapshot, toSnapshot, type LayoutSnapshot, type RestoreOptions, type RestoreReport, type SessionFallback, type TabSnapshot, type WorktreeSnapshot } from "./layoutSnapshot";
import { DONE_QUIET_MS, INTERRUPT_MS, NO_CAPS, STALE_MS, capsFor, isInterrupt, start, step, worktreeDot, type Caps, type StatusEvent, type StatusState, type TabStatus } from "./status";

/** The CLI behind a tab, for its hook caps and title rules; null for custom profiles and shells. */
export type TabCli = "claude" | "codex" | null;

/**
 * What asks for the person: a state (`needs-you`, `done`, `failed`) reached on a pane nobody looks at
 * marks it unread, and so does a terminal `bell`.
 */
export type Attention = "needs-you" | "done" | "failed" | "bell";

/** A tab's colour: one of ten theme tokens (`--x-tab-color-1` … `10`), or none. */
export type TabColor = "none" | "c1" | "c2" | "c3" | "c4" | "c5" | "c6" | "c7" | "c8" | "c9" | "c10";
export const TAB_COLORS: readonly TabColor[] = ["none", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];

export interface Tab {
  id: string;
  worktree: string;
  profileId: PtyProfile;
  /** The account the profile runs under, if one was picked. */
  account: string | null;
  /** Where the account the pty runs under came from (`tab`, `profile`, `active`); null until it started or without one. */
  accountSource: AccountSource | null;
  /** What the tab was started as (`ask`, `accept-edits`, `skip`); filled in once known. */
  permissions: string;
  /** Agent tabs count for the worktree's status dot; plain shells do not. */
  agent: boolean;
  status: TabStatus;
  /** The CLI the profile runs; picks the hook caps once the pty reports whether it has hooks. */
  cli: TabCli;
  /** It reached `needs-you`, `done` or `failed` while nobody looked; cleared when it is seen. */
  unread: boolean;
  /** When `unread` was last set; null while it is not. */
  unreadAt: number | null;
  /** Why it is unread; null while it is not. */
  unreadReason: Attention | null;
  /** The terminal's own title (OSC 0/2), or the hand-given name when `renamed`. */
  title: string | null;
  /** Named by hand: later titles from the terminal leave the name alone. */
  renamed: boolean;
  /** The agent session id this tab resumed; null for a new session. */
  resumeOf: string | null;
  /** The agent's own session id, from its hooks (latest wins) or the resumed id; null until known. */
  agentSession: string | null;
  /** When the tab was opened or resumed, in ms. */
  openedAt: number;
  /** Pinned tabs sort first and are skipped by Close Others and Close to the Right. */
  pinned: boolean;
  color: TabColor;
  /** Set once the pty exited; `null` when it was killed or its code is unknown. */
  exitCode?: number | null;
  client: PtyClient;
}

/** How long removing a worktree waits for its terminals to report their exit. */
export const EXIT_WAIT_MS = 5000;
const TICK_MS = 1000;
// Longer titles are cut; a terminal can send anything.
const TITLE_MAX = 200;

export { DONE_QUIET_MS };

interface Entry {
  tab: Tab;
  state: StatusState;
  /** What the launch reports; the state uses them only while hooks are on. */
  caps: Caps;
  /** The program's last title (OSC 0/2), kept while the tab is named by hand. */
  programTitle: string | null;
}

// Only an exit ends a tab: `failed` can also be a turn that failed, with the pty still alive.
const ended = (tab: Tab) => tab.exitCode !== undefined;
const asks = (status: TabStatus): status is Exclude<Attention, "bell"> =>
  status === "needs-you" || status === "done" || status === "failed";

/** The CLI of a built-in profile id, for callers that have no profile view. */
export function cliOf(profileId: PtyProfile): TabCli {
  return profileId === "claude" || profileId === "codex" ? profileId : null;
}

/**
 * The account to start a tab's pty with: only one the tab itself picked. An account that came from the
 * profile or the active account is looked up again at each start, so a restart keeps following it.
 */
export function ownAccount(tab: Pick<Tab, "account" | "accountSource">): string | null {
  return tab.accountSource === "profile" || tab.accountSource === "active" ? null : tab.account;
}

/** What a closed tab leaves behind for "Reopen closed tab". */
interface ClosedTab {
  worktree: string;
  profileId: PtyProfile;
  account: string | null;
  cli: TabCli;
}

/** How many closed tabs `reopenClosed` can give back. */
export const CLOSED_KEPT = 10;
/** How many tabs of a worktree the focus order remembers. */
const RECENT_KEPT = 50;

/**
 * The terminal tabs of every worktree, alive for the whole app. Views read it through
 * `subscribe` + `tabs`, which hand back the same array until something changes.
 */
export class Sessions {
  private readonly entries = new Map<string, Entry>();
  private readonly cache = new Map<string, Tab[]>();
  private readonly layouts = new Map<string, PaneLayout>();
  private readonly recent = new Map<string, string[]>();
  private readonly listeners = new Set<() => void>();
  private readonly waiting = new Map<string, () => void>();
  // Tabs being closed with their worktree: their exits are no news.
  private readonly closing = new Set<string>();
  // The panes the person looks at now, and the worktrees marked unread by hand.
  private seen = new Set<string>();
  private readonly marked = new Set<string>();
  private readonly attention = new Set<(tab: Tab, status: Attention, detail: HookDetail | null) => void>();
  private interval: ReturnType<typeof setInterval> | null = null;
  // One-shot timers per tab: an interrupt settling, a done waiting to be announced.
  private readonly settle = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly announce = new Map<string, ReturnType<typeof setTimeout>>();
  // A working hooked pane with no event for STALE_MS rests.
  private readonly stale = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unlisten: Promise<() => void>[];
  private hooksOn = true;
  // A restore runs once per app run.
  private restored = false;
  /** Saved worktrees this run could not load (a missing repo): kept in every snapshot until `dropCarried`. */
  private carried = new Map<string, WorktreeSnapshot>();
  // Restored tabs whose terminal starts when they are first shown.
  private readonly lazy = new Set<string>();
  // Tabs the person closed, newest last.
  private readonly closed: ClosedTab[] = [];

  constructor(
    private readonly api: Api,
    private readonly now: () => number = () => Date.now(),
    /** Whether a pane the person looks at stays quiet. Off: it notifies too (but is never unread). */
    private readonly suppressWhenFocused: () => boolean = () => true,
  ) {
    this.unlisten = [
      api.onPtyExit((e) => this.apply(e.id, { kind: "exit", code: e.code })),
      // Windows compare against this clock, so a hook is timed when it arrives.
      api.onPtyHook((h) => {
        this.apply(h.id, { kind: "hook", event: h.event, at: this.now(), detail: h.detail });
        this.noteSession(h.id, h.session ?? null);
      }),
    ];
  }

  /** `cli` comes from the profile view; left out, the built-in ids `claude` and `codex` name their own. */
  open(worktree: string, profileId: PtyProfile, account: string | null = null, cli?: TabCli): Tab {
    const entry = this.entry(worktree, profileId, account, cli === undefined ? cliOf(profileId) : cli);
    this.entries.set(entry.tab.id, entry);
    this.cache.delete(worktree);
    const layout = this.layouts.get(worktree);
    this.layouts.set(worktree, layout ? addTab(layout, entry.tab.id) : single(entry.tab.id));
    this.emit();
    return entry.tab;
  }

  /**
   * Opens an agent tab that continues the CLI session `sessionId`. The tab carries `title` (the
   * session's first prompt) until the terminal sets its own; a hand name still wins.
   */
  resume(worktree: string, profileId: PtyProfile, account: string | null, sessionId: string, title: string | null = null, cli?: TabCli): Tab {
    const entry = this.entry(worktree, profileId, account, cli === undefined ? cliOf(profileId) : cli, sessionId, title);
    this.entries.set(entry.tab.id, entry);
    this.cache.delete(worktree);
    const layout = this.layouts.get(worktree);
    this.layouts.set(worktree, layout ? addTab(layout, entry.tab.id) : single(entry.tab.id));
    this.emit();
    return entry.tab;
  }

  /** What `layout.json` keeps of every worktree's tabs and panes; only `savedAt` depends on the clock. */
  snapshot(): LayoutSnapshot {
    const worktrees: LayoutSnapshot["worktrees"] = {};
    for (const [path, layout] of this.layouts) {
      const one = toSnapshot(layout, (id) => this.entries.get(id)?.tab ?? null);
      if (one) worktrees[path] = one;
    }
    // Worktrees that were not loaded keep their saved entry, unless they have tabs now.
    for (const [path, one] of this.carried) if (!this.layouts.has(path)) worktrees[path] ??= one;
    return { version: LAYOUT_VERSION, savedAt: this.now(), worktrees };
  }

  /**
   * Opens the tabs of `s` again by `mode`, once per app run (a second call does nothing). Worktrees
   * that are not in the registry, or that already have tabs, are left alone. Each tab goes through
   * the normal `open` / `resume`, so the policy and setup gates apply when its pty starts.
   */
  async restore(s: LayoutSnapshot, mode: RestoreMode, fallback: SessionFallback, options: RestoreOptions = {}): Promise<RestoreReport> {
    const report: RestoreReport = { resumed: 0, fresh: 0, skipped: [], opened: [] };
    if (this.restored) return report;
    this.restored = true;
    if (mode === "none" || !s || s.version !== LAYOUT_VERSION || typeof s.worktrees !== "object" || !s.worktrees) return report;
    // Tabs whose pty still runs in the terminal service come back attached to it, before any resume.
    const state = (await this.api.ptydStatus().catch(() => null))?.state;
    const attach = state === "running" || state === "old-version";
    for (const [worktree, one] of Object.entries(s.worktrees)) {
      if (options.known && !options.known(worktree)) {
        report.skipped.push({ worktree, reason: "unknownWorktree" });
        if (one && options.carry?.(worktree)) this.carried.set(worktree, one);
        continue;
      }
      if (this.layouts.has(worktree) || !one || typeof one.tabs !== "object" || !one.layout) continue;
      try {
        await this.restoreWorktree(worktree, one, mode, fallback, options, report, attach);
      } catch {
        // A snapshot this build cannot read (hand-edited, from a bug) must not stop the other worktrees.
      }
    }
    return report;
  }

  private async restoreWorktree(worktree: string, one: WorktreeSnapshot, mode: RestoreMode, fallback: SessionFallback, options: RestoreOptions, report: RestoreReport, attach: boolean): Promise<void> {
    const ids = new Map<string, string>();
    const files = new Set<string>();
    const opened: string[] = [];
    for (const leaf of leaves(one.layout)) {
      if (leaf.kind !== "leaf") continue;
      for (const key of leaf.tabs) {
        const snap = one.tabs[key];
        if (!snap) continue;
        if (snap.kind === "review") files.add(key);
        else if (snap.kind === "file") {
          const ok = await (options.openFile?.(worktree, snap.rel) ?? Promise.resolve(false)).catch(() => false);
          if (ok) files.add(key);
        } else if (snap.kind === "terminal") {
          const tab = (attach && (await this.attachTerminal(worktree, snap, report))) || (await this.restoreTerminal(worktree, snap, mode, fallback, report));
          if (!tab) continue;
          ids.set(key, tab.id);
          opened.push(tab.id);
        }
      }
    }
    const layout = fromSnapshot(one.layout, ids, (id) => files.has(id));
    report.opened.push(...opened);
    if (layout) this.setLayout(worktree, layout);
  }

  /** Forgets the saved entry of a worktree that is gone for good (removed through the app). */
  dropCarried(worktree: string): void {
    this.carried.delete(worktree);
  }

  /** Paths of the worktrees whose saved entry is carried. */
  carriedWorktrees(): string[] {
    return [...this.carried.keys()];
  }

  /**
   * One terminal tab of a snapshot attached to its pty in the terminal service, with the output made
   * since it was saved; null when the service does not hold it (`pty_gone`), and the tab then comes
   * back the usual way. A live pty comes back whatever the mode, as nothing about it restarts.
   */
  private async attachTerminal(worktree: string, snap: Extract<TabSnapshot, { kind: "terminal" }>, report: RestoreReport): Promise<Tab | null> {
    const id = snap.ptyId;
    if (typeof id !== "string" || !id || this.entries.has(id)) return null;
    const cli = snap.cli === undefined ? cliOf(snap.profileId) : snap.cli;
    const entry = this.entry(worktree, snap.profileId, snap.account, cli, null, snap.title, id);
    try {
      await entry.tab.client.attach(typeof snap.seq === "number" && snap.seq >= 0 ? snap.seq : 0);
    } catch {
      return null;
    }
    const color = TAB_COLORS.includes(snap.color) ? snap.color : "none";
    entry.tab = {
      ...entry.tab,
      agent: snap.agent,
      agentSession: snap.agentSession,
      openedAt: snap.openedAt,
      renamed: snap.renamed === true,
      pinned: snap.pinned === true,
      color,
    };
    this.entries.set(id, entry);
    this.cache.delete(worktree);
    const layout = this.layouts.get(worktree);
    this.layouts.set(worktree, layout ? addTab(layout, id) : single(id));
    this.lazy.add(id);
    report.attached = (report.attached ?? 0) + 1;
    this.emit();
    return entry.tab;
  }

  /** One terminal tab of a snapshot, or null when `mode` or a missing session leaves it out. */
  private async restoreTerminal(worktree: string, snap: Extract<TabSnapshot, { kind: "terminal" }>, mode: RestoreMode, fallback: SessionFallback, report: RestoreReport): Promise<Tab | null> {
    const cli = snap.cli === undefined ? cliOf(snap.profileId) : snap.cli;
    let tab: Tab;
    if (snap.agent) {
      let id = snap.agentSession;
      if (!id && cli) id = await fallback(worktree, cli, snap.openedAt).catch(() => null);
      if (id) {
        tab = this.resume(worktree, snap.profileId, snap.account, id, snap.title, cli);
        report.resumed++;
      } else if (mode === "all") {
        tab = this.open(worktree, snap.profileId, snap.account, cli);
        report.fresh++;
      } else {
        report.skipped.push({ worktree, reason: "noSession" });
        return null;
      }
    } else if (mode === "all") {
      tab = this.open(worktree, snap.profileId, snap.account, cli);
      report.fresh++;
    } else return null;
    const entry = this.entries.get(tab.id)!;
    const color = TAB_COLORS.includes(snap.color) ? snap.color : "none";
    this.lazy.add(tab.id);
    this.update(entry, { title: snap.title, renamed: snap.renamed === true, pinned: snap.pinned === true, color });
    return entry.tab;
  }

  /** Every tab that resumed an agent session, in the order they opened. */
  resumed(): Tab[] {
    return [...this.entries.values()].filter((e) => e.tab.resumeOf !== null).map((e) => e.tab);
  }

  /** A restored tab that has not been shown yet: its view leaves the terminal unstarted until it is. */
  deferred(id: string): boolean {
    return this.lazy.has(id);
  }

  /** A tab by its pty id; `null` when it is gone. */
  tab(id: string): Tab | null {
    return this.entries.get(id)?.tab ?? null;
  }

  /**
   * Starts a tab again in its place: same worktree and profile, a new pty id. The old pty is
   * killed, since an exited terminal keeps its slot until then. `null` for an unknown id.
   */
  restart(id: string): Tab | null {
    const old = this.entries.get(id);
    if (!old) return null;
    return this.replace(old, old.tab.account, old.tab.resumeOf, old.tab.agentSession);
  }

  /**
   * `restart` under `account`: for a tab that follows the active account, the one it follows now. The
   * tab keeps its account source and resumes its agent session (the latest one its hooks reported);
   * `fresh` starts a new conversation instead. `null` for an unknown id.
   */
  restartAs(id: string, account: string | null, fresh = false): Tab | null {
    const old = this.entries.get(id);
    if (!old) return null;
    const session = fresh ? null : (old.tab.agentSession ?? old.tab.resumeOf);
    return this.replace(old, account, session, session);
  }

  private replace(old: Entry, account: string | null, resumeOf: string | null, agentSession: string | null): Tab {
    const id = old.tab.id;
    this.clear(this.settle, id);
    this.clear(this.announce, id);
    this.clear(this.stale, id);
    const next = this.entry(old.tab.worktree, old.tab.profileId, account, old.tab.cli, resumeOf, old.tab.title);
    // The pin and colour belong to the slot, not to the pty; so does the agent's session id, which a restart must not lose.
    next.tab = { ...next.tab, accountSource: old.tab.accountSource, pinned: old.tab.pinned, color: old.tab.color, agentSession };
    const kept = [...this.entries].map(([key, e]): [string, Entry] => (key === id ? [next.tab.id, next] : [key, e]));
    this.entries.clear();
    for (const [key, e] of kept) this.entries.set(key, e);
    this.cache.delete(old.tab.worktree);
    // The new tab takes the old one's place in the layout.
    const layout = this.layouts.get(old.tab.worktree);
    if (layout) this.layouts.set(old.tab.worktree, replaceTab(layout, id, next.tab.id));
    this.sync();
    this.emit();
    void old.tab.client.dispose();
    return next.tab;
  }

  /** Closes one tab and kills its pty. */
  async close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const { worktree, profileId, cli } = entry.tab;
    this.closed.push({ worktree, profileId, account: ownAccount(entry.tab), cli });
    if (this.closed.length > CLOSED_KEPT) this.closed.shift();
    this.remove([entry]);
    await entry.tab.client.dispose();
  }

  /**
   * Opens a tab like the most recent one closed in `worktree` and forgets that one. An agent comes
   * back as a fresh agent (resuming is the session history's job). `null` when none was closed.
   */
  reopenClosed(worktree: string): Tab | null {
    let at = this.closed.length - 1;
    while (at >= 0 && this.closed[at].worktree !== worktree) at--;
    if (at < 0) return null;
    const [last] = this.closed.splice(at, 1);
    return this.open(last.worktree, last.profileId, last.account, last.cli);
  }

  /** Kills every tab of a worktree; resolves when each reported its exit, or after 5 s. */
  async closeWorktree(worktree: string): Promise<void> {
    const entries = [...this.entries.values()].filter((e) => e.tab.worktree === worktree);
    const live = entries.filter((e) => !ended(e.tab));
    for (const e of entries) this.closing.add(e.tab.id);
    // Listen before killing: the exit event can arrive before dispose resolves.
    const exits = Promise.all(
      live.map((e) => new Promise<void>((resolve) => this.waiting.set(e.tab.id, resolve))),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, EXIT_WAIT_MS)));
    const kills = Promise.all(entries.map((e) => e.tab.client.dispose())).then(() => {
      // A tab whose pty never started has no exit to report.
      for (const e of live) if (!e.tab.client.spawned) this.waiting.get(e.tab.id)?.();
    });
    await Promise.race([Promise.all([exits, kills]), giveUp]);
    clearTimeout(timer);
    for (const e of live) this.waiting.delete(e.tab.id);
    for (const e of entries) this.closing.delete(e.tab.id);
    this.remove(entries);
  }

  tabs(worktree: string): Tab[] {
    let tabs = this.cache.get(worktree);
    if (!tabs) {
      const all = [...this.entries.values()].filter((e) => e.tab.worktree === worktree).map((e) => e.tab);
      tabs = [...all.filter((t) => t.pinned), ...all.filter((t) => !t.pinned)];
      this.cache.set(worktree, tabs);
    }
    return tabs;
  }

  /** The pane layout of a worktree's tabs; the same object until it changes. `null` when it has none. */
  layout(worktree: string): PaneLayout | null {
    return this.layouts.get(worktree) ?? null;
  }

  /** Tab ids of a worktree, the one focused last first; they may include tabs that have since closed. */
  recentTabs(worktree: string): readonly string[] {
    return this.recent.get(worktree) ?? [];
  }

  /** `id` came to the front of the focused pane. Nobody is told: only Ctrl+Tab reads the list. */
  noteFocused(worktree: string, id: string): void {
    const list = this.recent.get(worktree) ?? [];
    if (list[0] === id) return;
    this.recent.set(worktree, [id, ...list.filter((t) => t !== id)].slice(0, RECENT_KEPT));
  }

  /** Sets or clears a worktree's layout. Tell nobody when nothing changed. */
  setLayout(worktree: string, next: PaneLayout | null): void {
    const before = this.layouts.get(worktree) ?? null;
    if (before === next) return;
    if (next) this.layouts.set(worktree, next);
    else this.layouts.delete(worktree);
    this.emit();
  }

  /**
   * The terminals on screen in a worktree: the active tab of each pane, or of the expanded pane only.
   * Ids that are not terminals (the review tab) are left out.
   */
  visible(worktree: string): string[] {
    const layout = this.layouts.get(worktree);
    if (!layout) return [];
    const shown = leaves(layout).filter((n) => layout.expanded === null || n.id === layout.expanded);
    return shown.flatMap((n) => (n.kind === "leaf" && this.entries.has(n.active) ? [n.active] : []));
  }

  /** Every worktree that has a tab, in the order its first tab opened. */
  worktrees(): string[] {
    return [...new Set([...this.entries.values()].map((e) => e.tab.worktree))];
  }

  /** The status a worktree shows, from its agent tabs only. */
  dot(worktree: string): TabStatus | null {
    return worktreeDot(
      this.tabs(worktree)
        .filter((t) => t.agent)
        .map((t) => t.status),
    );
  }

  /** When any tab of a worktree last produced output (not an echo of typing); null if none did. */
  lastActivity(worktree: string): number | null {
    let latest = 0;
    for (const e of this.entries.values()) if (e.tab.worktree === worktree) latest = Math.max(latest, e.state.lastOutput);
    return latest > 0 ? latest : null;
  }

  /** The distinct profiles of a worktree's tabs, in tab order. */
  profilesOf(worktree: string): PtyProfile[] {
    return [...new Set(this.tabs(worktree).map((t) => t.profileId))];
  }

  /** Records what a tab's pty started as: its effective permissions, account and hook caps. */
  noteStarted(id: string, info: PtyInfo): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.caps = capsFor(info.hooks ? info.hookEvents : []);
    entry.state = { ...entry.state, caps: this.hooksOn ? entry.caps : NO_CAPS };
    this.sync();
    // A tab opened without a profile view (the palette, a prompt) learns its CLI here, for title rules.
    const reported: TabCli = info.cli === "claude" || info.cli === "codex" ? info.cli : null;
    const cli = entry.tab.cli ?? reported;
    if (entry.tab.permissions === info.permissions && entry.tab.account === info.account && entry.tab.accountSource === info.accountSource && entry.tab.cli === cli) return;
    this.update(entry, { permissions: info.permissions, account: info.account, accountSource: info.accountSource, cli });
  }

  /**
   * The hooks switch. Off, the `.off` marker drops every hook event, so each pane falls back to timing
   * (a hooked turn in progress then ends on quiet); on again, panes get back what their launch reports.
   */
  setHooks(on: boolean): void {
    if (on === this.hooksOn) return;
    this.hooksOn = on;
    for (const e of this.entries.values()) {
      const before = e.state;
      e.state = { ...before, caps: on ? e.caps : NO_CAPS, interruptAt: null };
      this.watchStale(e, before);
    }
    this.sync();
  }

  /** The agent's own session id from a hook; the latest one wins, a hook without one changes nothing. */
  private noteSession(id: string, session: string | null): void {
    const entry = this.entries.get(id);
    if (!entry || !session || entry.tab.agentSession === session) return;
    this.update(entry, { agentSession: session });
  }

  /** A keystroke batch from the person. Escape or Ctrl-C on a hooked working pane may stop its turn. */
  noteInput(id: string, text = ""): void {
    const interrupt = isInterrupt(text);
    this.apply(id, { kind: "input", at: this.now(), ...(interrupt ? { interrupt } : {}) });
    const entry = this.entries.get(id);
    if (!interrupt || entry?.state.interruptAt == null) return;
    this.clear(this.settle, id);
    this.settle.set(
      id,
      setTimeout(() => {
        this.settle.delete(id);
        this.apply(id, { kind: "tick", at: this.now() });
      }, INTERRUPT_MS),
    );
  }

  noteOutput(id: string, bytes: number): void {
    if (bytes > 0) this.apply(id, { kind: "output", at: this.now() });
  }

  /** A status a title rule read from the terminal title (see `titles.ts`). */
  noteTitleStatus(id: string, status: "working" | "needs-you" | "idle"): void {
    this.apply(id, { kind: "title", status, at: this.now() });
  }

  /** The terminal's title (OSC 0/2) names the tab, unless it was named by hand. */
  noteTitle(id: string, title: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const next = title.trim().slice(0, TITLE_MAX) || null;
    entry.programTitle = next;
    if (entry.tab.renamed || entry.tab.title === next) return;
    this.update(entry, { title: next });
  }

  /** Names a tab by hand; later titles from the terminal no longer change it. An alias of `setTitle`; blank is ignored. */
  rename(id: string, name: string): void {
    if (name.trim()) this.setTitle(id, name);
  }

  /** Pins or unpins a tab; pinned tabs come first in `tabs()` and in their pane's strip, in the order they had. */
  setPinned(id: string, pinned: boolean): void {
    const entry = this.entries.get(id);
    if (!entry || entry.tab.pinned === pinned) return;
    const worktree = entry.tab.worktree;
    entry.tab = { ...entry.tab, pinned };
    this.cache.delete(worktree);
    const layout = this.layouts.get(worktree);
    const pane = layout && paneOf(layout, id);
    if (layout && pane) this.layouts.set(worktree, pinFirst(layout, pane, (t) => this.entries.get(t)?.tab.pinned ?? false));
    this.emit();
  }

  setColor(id: string, color: TabColor): void {
    const entry = this.entries.get(id);
    if (!entry || !TAB_COLORS.includes(color) || entry.tab.color === color) return;
    this.update(entry, { color });
  }

  /** A title set by the person; null or blank gives back the program's last title. */
  setTitle(id: string, title: string | null): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const next = title?.trim().slice(0, TITLE_MAX) || null;
    const patch = next ? { title: next, renamed: true } : { title: entry.programTitle, renamed: false };
    if (entry.tab.title === patch.title && entry.tab.renamed === patch.renamed) return;
    this.update(entry, patch);
  }

  /** Moves a tab into a new pane beside its pane, focused. A tab alone in its pane stays (no-op). */
  moveToSplit(id: string, dir: PaneDir): void {
    const entry = this.entries.get(id);
    if (!entry || !this.canMoveToSplit(id)) return;
    const layout = this.layouts.get(entry.tab.worktree)!;
    const pane = paneOf(layout, id)!;
    const without = removeTab(layout, id);
    if (without) this.setLayout(entry.tab.worktree, splitPane(without, pane, dir, id));
  }

  /** Whether `moveToSplit` would move the tab: it shares its pane with another tab. */
  canMoveToSplit(id: string): boolean {
    const entry = this.entries.get(id);
    return !!entry && !!this.layouts.get(entry.tab.worktree) && (this.stripOf(id)?.length ?? 0) > 1;
  }

  /** Closes the other tabs of this tab's pane (the worktree's without a layout), except pinned ones. */
  closeOthers(id: string): void {
    const strip = this.stripOf(id);
    if (strip) this.closeUnpinned(strip.filter((t) => t !== id));
  }

  /** Closes the tabs after this one in its pane's strip, except pinned ones. */
  closeToRight(id: string): void {
    const strip = this.stripOf(id);
    if (strip) this.closeUnpinned(strip.slice(strip.indexOf(id) + 1));
  }

  /**
   * The panes the person looks at now (window focused, workspace shown, the selected worktree's
   * active tab of every pane). Each newly seen tab loses `unread`, a `done` one turns
   * idle, and its worktree's hand mark goes.
   */
  setSeen(tabIds: string[]): void {
    const before = this.seen;
    this.seen = new Set(tabIds);
    const at = this.now();
    for (const id of this.seen) {
      if (before.has(id)) continue;
      const entry = this.entries.get(id);
      if (!entry) continue;
      if (this.marked.delete(entry.tab.worktree)) this.emit();
      this.advance(entry, { kind: "seen", at });
      if (entry.tab.unread) this.update(entry, { unread: false, unreadAt: null, unreadReason: null });
    }
    this.sync();
  }

  /** A terminal bell (BEL outside an OSC string) on a pane: unread with the reason `bell`, if nobody looks. */
  noteBell(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.state.dead || this.closing.has(id)) return;
    const seen = this.seen.has(id);
    if (seen && this.suppressWhenFocused()) return;
    this.call(entry, "bell", null, !seen);
  }

  /** Marks a worktree read: its hand mark goes and so does the unread of each of its tabs. */
  markRead(worktree: string): void {
    let changed = this.marked.delete(worktree);
    for (const e of this.entries.values()) {
      if (e.tab.worktree !== worktree || !e.tab.unread) continue;
      e.tab = { ...e.tab, unread: false, unreadAt: null, unreadReason: null };
      changed = true;
    }
    if (!changed) return;
    this.cache.delete(worktree);
    this.emit();
  }

  /** Marks a worktree unread by hand, until one of its panes is next seen. */
  markUnread(worktree: string): void {
    if (this.marked.has(worktree)) return;
    this.marked.add(worktree);
    this.emit();
  }

  /** A worktree is unread when any of its tabs is, or it was marked by hand. */
  unread(worktree: string): boolean {
    return this.marked.has(worktree) || this.tabs(worktree).some((t) => t.unread);
  }

  /** Every unread tab, in the order they opened. */
  unreadTabs(): Tab[] {
    return [...this.entries.values()].filter((e) => e.tab.unread).map((e) => e.tab);
  }

  /** The worktrees that are unread: marked by hand, or with an unread tab that `count` accepts. */
  unreadWorktrees(count: (tab: Tab) => boolean = () => true): string[] {
    const found = new Set(this.marked);
    for (const e of this.entries.values()) if (e.tab.unread && count(e.tab)) found.add(e.tab.worktree);
    return [...found];
  }

  /** Called once per transition that asks for the person, with what the hook said (never the prompt). */
  onAttention(listener: (tab: Tab, status: Attention, detail: HookDetail | null) => void): () => void {
    this.attention.add(listener);
    return () => this.attention.delete(listener);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Kills every tab, then stops the pty listeners and the timer. */
  dispose(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.listeners.clear();
    this.attention.clear();
    for (const t of [...this.settle.values(), ...this.announce.values(), ...this.stale.values()]) clearTimeout(t);
    this.settle.clear();
    this.announce.clear();
    this.stale.clear();
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.cache.clear();
    this.layouts.clear();
    for (const e of entries) void e.tab.client.dispose();
    for (const off of this.unlisten) void off.then((stop) => stop()).catch(() => {});
  }

  private apply(id: string, event: StatusEvent): void {
    const entry = this.entries.get(id);
    if (event.kind === "exit") {
      this.waiting.get(id)?.();
      this.waiting.delete(id);
    }
    if (!entry) return;
    this.advance(entry, event);
    this.sync();
  }

  /** Steps one entry; true when it reached a state worth a look (see `news` below). */
  private advance(entry: Entry, event: StatusEvent): boolean {
    const id = entry.tab.id;
    const seen = this.seen.has(id);
    const before = entry.state;
    const next = step(before, event, seen);
    // What the pane reached, as if nobody looked: a `done` seen at once rests as idle, yet it happened.
    const news = seen ? step(before, event, false).status : next.status;
    entry.state = next;
    this.watchStale(entry, before);
    const statusChanged = next.status !== before.status;
    const exit = event.kind === "exit" ? { exitCode: event.code } : {};
    if (!statusChanged && news === next.status) {
      if (event.kind === "exit") this.update(entry, exit);
      return false;
    }
    if (statusChanged) {
      // Any change ends a done that was still settling.
      this.clear(this.announce, id);
      this.update(entry, { status: next.status, ...exit });
    }
    // Only agents ask for the person; a closing tab's exit is expected.
    const quiet = seen && this.suppressWhenFocused();
    if (!entry.tab.agent || quiet || this.closing.has(id) || news === before.status || !asks(news)) return statusChanged;
    const detail = event.kind === "hook" ? (event.detail ?? null) : null;
    if (news !== "done") this.call(entry, news, detail, !seen);
    else {
      // A finished turn is news only if it stays finished: no new prompt, no interrupt, no look.
      this.announce.set(
        id,
        setTimeout(() => {
          this.announce.delete(id);
          const live = this.entries.get(id);
          if (!live || this.closing.has(id)) return;
          const looked = this.seen.has(id);
          if (live.tab.status === "done" ? !looked : !this.suppressWhenFocused()) this.call(live, "done", detail, !looked);
        }, DONE_QUIET_MS),
      );
    }
    return true;
  }

  /** Tells the attention listeners; marks the tab unread when `mark` (nobody is looking). */
  private call(entry: Entry, status: Attention, detail: HookDetail | null, mark: boolean): void {
    const tab = entry.tab;
    // A bell on a pane that is already unread for a state keeps that state as its reason.
    if (mark && !(tab.unread && status === "bell")) {
      this.update(entry, { unread: true, unreadAt: this.now(), unreadReason: status });
    }
    for (const l of [...this.attention]) l(entry.tab, status, detail);
  }

  /** One timer per working hooked pane: STALE_MS after its last event it gets a tick that settles it. */
  private watchStale(entry: Entry, before: StatusState): void {
    const id = entry.tab.id;
    const s = entry.state;
    if (s.status !== "working" || !s.caps.turnDone) return this.clear(this.stale, id);
    if (this.stale.has(id) && s.lastEvent === before.lastEvent) return;
    this.clear(this.stale, id);
    this.stale.set(
      id,
      setTimeout(() => {
        this.stale.delete(id);
        this.apply(id, { kind: "tick", at: this.now() });
      }, Math.max(0, s.lastEvent + STALE_MS - this.now())),
    );
  }

  private clear(timers: Map<string, ReturnType<typeof setTimeout>>, id: string): void {
    const t = timers.get(id);
    if (t === undefined) return;
    clearTimeout(t);
    timers.delete(id);
  }

  /** The tab ids of the strip holding `id`: its pane's, or the worktree's without a layout. Null for an unknown id. */
  private stripOf(id: string): string[] | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const layout = this.layouts.get(entry.tab.worktree);
    const leaf = layout && leaves(layout).find((n) => n.kind === "leaf" && n.tabs.includes(id));
    if (leaf && leaf.kind === "leaf") return leaf.tabs;
    return this.tabs(entry.tab.worktree).map((t) => t.id);
  }

  /** Closes these tabs at once (one change) and kills their ptys; pinned ones and the review tab stay. */
  private closeUnpinned(ids: string[]): void {
    const entries = ids.flatMap((t) => {
      const e = this.entries.get(t);
      return e && !e.tab.pinned ? [e] : [];
    });
    if (!entries.length) return;
    this.remove(entries);
    for (const e of entries) void e.tab.client.dispose();
  }

  private update(entry: Entry, patch: Partial<Tab>): void {
    entry.tab = { ...entry.tab, ...patch };
    this.cache.delete(entry.tab.worktree);
    this.emit();
  }

  private entry(worktree: string, profileId: PtyProfile, account: string | null, cli: TabCli, resumeOf: string | null = null, title: string | null = null, id: string = crypto.randomUUID()): Entry {
    const tab: Tab = {
      id,
      worktree,
      profileId,
      account,
      accountSource: null,
      permissions: "ask",
      // The setup script's tab (`xdev:` ids) is a terminal, not an agent: it must not drive the status dot.
      agent: !profileId.startsWith("shell") && !profileId.startsWith("xdev:"),
      status: "idle",
      cli,
      unread: false,
      unreadAt: null,
      unreadReason: null,
      title,
      renamed: false,
      resumeOf,
      agentSession: resumeOf,
      openedAt: this.now(),
      pinned: false,
      color: "none",
      client: new PtyClient(this.api, id, resumeOf ?? undefined),
    };
    // Caps stay off until the pty says whether it got hook flags.
    return { tab, state: start(), caps: NO_CAPS, programTitle: null };
  }

  private remove(entries: Entry[]): void {
    for (const e of entries) {
      this.clear(this.settle, e.tab.id);
      this.clear(this.announce, e.tab.id);
      this.clear(this.stale, e.tab.id);
      this.entries.delete(e.tab.id);
      this.lazy.delete(e.tab.id);
      this.cache.delete(e.tab.worktree);
      const layout = this.layouts.get(e.tab.worktree);
      if (layout) {
        const next = removeTab(layout, e.tab.id);
        if (next) this.layouts.set(e.tab.worktree, next);
        else this.layouts.delete(e.tab.worktree);
      }
    }
    this.sync();
    this.emit();
  }

  /** The 1 s interval runs only while some tab is working and waits on quiet to end its turn. */
  private sync(): void {
    const working = [...this.entries.values()].some((e) => e.state.status === "working" && !e.state.caps.prompt);
    if (working && !this.interval) {
      this.interval = setInterval(() => {
        const at = this.now();
        for (const e of this.entries.values()) this.advance(e, { kind: "tick", at });
        this.sync();
      }, TICK_MS);
    } else if (!working && this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
