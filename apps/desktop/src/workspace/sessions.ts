import type { Api, HookDetail, PtyInfo, PtyProfile } from "@/api";
import { PtyClient } from "@/terminal/ptyClient";
import { INTERRUPT_MS, STALE_MS, capsFor, isInterrupt, start, step, worktreeDot, type StatusEvent, type StatusState, type TabStatus } from "./status";

/** The CLI behind a tab, for its hook caps and title rules; null for custom profiles and shells. */
export type TabCli = "claude" | "codex" | null;

/**
 * What asks for the person: a state (`needs-you`, `done`, `failed`) reached on a pane nobody looks at
 * marks it unread, and so does a terminal `bell`.
 */
export type Attention = "needs-you" | "done" | "failed" | "bell";

export interface Tab {
  id: string;
  worktree: string;
  profileId: PtyProfile;
  /** The account the profile runs under, if one was picked. */
  account: string | null;
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
  /** Set once the pty exited; `null` when it was killed or its code is unknown. */
  exitCode?: number | null;
  client: PtyClient;
}

/**
 * Two terminal tabs of a worktree shown together: the active tab and `second`, side by side
 * (`right`) or stacked (`down`). `null` is no split. One level only.
 */
export type Split = { dir: "right" | "down"; second: string } | null;

/** How long removing a worktree waits for its terminals to report their exit. */
export const EXIT_WAIT_MS = 5000;
const TICK_MS = 1000;
/** A finished turn is news only once the pane stayed done this long. */
export const DONE_QUIET_MS = 1500;
// Longer titles are cut; a terminal can send anything.
const TITLE_MAX = 200;

interface Entry {
  tab: Tab;
  state: StatusState;
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
 * The terminal tabs of every worktree, alive for the whole app. Views read it through
 * `subscribe` + `tabs`, which hand back the same array until something changes.
 */
export class Sessions {
  private readonly entries = new Map<string, Entry>();
  private readonly cache = new Map<string, Tab[]>();
  private readonly splits = new Map<string, NonNullable<Split>>();
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

  constructor(
    private readonly api: Api,
    private readonly now: () => number = () => Date.now(),
    /** Whether a pane the person looks at stays quiet. Off: it notifies too (but is never unread). */
    private readonly suppressWhenFocused: () => boolean = () => true,
  ) {
    this.unlisten = [
      api.onPtyExit((e) => this.apply(e.id, { kind: "exit", code: e.code })),
      // Windows compare against this clock, so a hook is timed when it arrives.
      api.onPtyHook((h) => this.apply(h.id, { kind: "hook", event: h.event, at: this.now(), detail: h.detail })),
    ];
  }

  /** `cli` comes from the profile view; left out, the built-in ids `claude` and `codex` name their own. */
  open(worktree: string, profileId: PtyProfile, account: string | null = null, cli?: TabCli): Tab {
    const entry = this.entry(worktree, profileId, account, cli === undefined ? cliOf(profileId) : cli);
    this.entries.set(entry.tab.id, entry);
    this.cache.delete(worktree);
    this.emit();
    return entry.tab;
  }

  /**
   * Starts a tab again in its place: same worktree and profile, a new pty id. The old pty is
   * killed, since an exited terminal keeps its slot until then. `null` for an unknown id.
   */
  restart(id: string): Tab | null {
    const old = this.entries.get(id);
    if (!old) return null;
    this.clear(this.settle, id);
    this.clear(this.announce, id);
    this.clear(this.stale, id);
    const next = this.entry(old.tab.worktree, old.tab.profileId, old.tab.account, old.tab.cli);
    const kept = [...this.entries].map(([key, e]): [string, Entry] => (key === id ? [next.tab.id, next] : [key, e]));
    this.entries.clear();
    for (const [key, e] of kept) this.entries.set(key, e);
    this.cache.delete(old.tab.worktree);
    // The new tab takes the old one's place in a split too.
    const split = this.splits.get(old.tab.worktree);
    if (split?.second === id) this.splits.set(old.tab.worktree, { ...split, second: next.tab.id });
    this.sync();
    this.emit();
    void old.tab.client.dispose();
    return next.tab;
  }

  /** Closes one tab and kills its pty. */
  async close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.remove([entry]);
    await entry.tab.client.dispose();
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
      tabs = [...this.entries.values()].filter((e) => e.tab.worktree === worktree).map((e) => e.tab);
      this.cache.set(worktree, tabs);
    }
    return tabs;
  }

  /** The split of a worktree's terminals; the same object until it changes. */
  split(worktree: string): Split {
    return this.splits.get(worktree) ?? null;
  }

  /** Sets or clears a worktree's split. A `second` that is not one of its tabs clears it. */
  setSplit(worktree: string, split: Split): void {
    if (split && this.tabs(worktree).some((t) => t.id === split.second)) this.splits.set(worktree, split);
    else if (!this.splits.delete(worktree)) return;
    this.emit();
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
    entry.state = { ...entry.state, caps: capsFor(info.hooks ? info.hookEvents : []) };
    this.sync();
    if (entry.tab.permissions === info.permissions && entry.tab.account === info.account) return;
    this.update(entry, { permissions: info.permissions, account: info.account });
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
    const next = title.trim().slice(0, TITLE_MAX) || null;
    if (!entry || entry.tab.renamed || entry.tab.title === next) return;
    this.update(entry, { title: next });
  }

  /** Names a tab by hand; later titles from the terminal no longer change it. */
  rename(id: string, name: string): void {
    const entry = this.entries.get(id);
    const next = name.trim().slice(0, TITLE_MAX);
    if (!entry || !next) return;
    this.update(entry, { title: next, renamed: true });
  }

  /**
   * The panes the person looks at now (window focused, workspace shown, the selected worktree's
   * front tab and its split partner). Each newly seen tab loses `unread`, a `done` one turns
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
    this.splits.clear();
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

  private update(entry: Entry, patch: Partial<Tab>): void {
    entry.tab = { ...entry.tab, ...patch };
    this.cache.delete(entry.tab.worktree);
    this.emit();
  }

  private entry(worktree: string, profileId: PtyProfile, account: string | null, cli: TabCli): Entry {
    const id = crypto.randomUUID();
    const tab: Tab = {
      id,
      worktree,
      profileId,
      account,
      permissions: "ask",
      agent: !profileId.startsWith("shell"),
      status: "idle",
      cli,
      unread: false,
      unreadAt: null,
      unreadReason: null,
      title: null,
      renamed: false,
      client: new PtyClient(this.api, id),
    };
    // Caps stay off until the pty says whether it got hook flags.
    return { tab, state: start() };
  }

  private remove(entries: Entry[]): void {
    for (const e of entries) {
      this.clear(this.settle, e.tab.id);
      this.clear(this.announce, e.tab.id);
      this.clear(this.stale, e.tab.id);
      this.entries.delete(e.tab.id);
      this.cache.delete(e.tab.worktree);
      // Closing the second tab of a split unsplits; so does leaving fewer than two tabs.
      const split = this.splits.get(e.tab.worktree);
      if (split && (split.second === e.tab.id || this.tabs(e.tab.worktree).length < 2)) this.splits.delete(e.tab.worktree);
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
