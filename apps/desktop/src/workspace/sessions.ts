import type { Api, PtyProfile } from "../api";
import { PtyClient } from "../terminal/ptyClient";
import { step, worktreeDot, type StatusEvent, type StatusState, type TabStatus } from "./status";

export interface Tab {
  id: string;
  worktree: string;
  profileId: PtyProfile;
  /** Agent tabs count for the worktree's status dot; plain shells do not. */
  agent: boolean;
  status: TabStatus;
  /** Set once the pty exited; `null` when it was killed or its code is unknown. */
  exitCode?: number | null;
  client: PtyClient;
}

/** How long removing a worktree waits for its terminals to report their exit. */
export const EXIT_WAIT_MS = 5000;
const TICK_MS = 1000;

interface Entry {
  tab: Tab;
  state: StatusState;
}

const ended = (status: TabStatus) => status === "failed" || status === "exited";

/**
 * The terminal tabs of every worktree, alive for the whole app. Views read it through
 * `subscribe` + `tabs`, which hand back the same array until something changes.
 */
export class Sessions {
  private readonly entries = new Map<string, Entry>();
  private readonly cache = new Map<string, Tab[]>();
  private readonly listeners = new Set<() => void>();
  private readonly waiting = new Map<string, () => void>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly unlisten: Promise<() => void>;

  constructor(
    private readonly api: Api,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.unlisten = api.onPtyExit((e) => this.apply(e.id, { kind: "exit", code: e.code }));
  }

  open(worktree: string, profileId: PtyProfile): Tab {
    const entry = this.entry(worktree, profileId);
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
    const next = this.entry(old.tab.worktree, old.tab.profileId);
    const kept = [...this.entries].map(([key, e]): [string, Entry] => (key === id ? [next.tab.id, next] : [key, e]));
    this.entries.clear();
    for (const [key, e] of kept) this.entries.set(key, e);
    this.cache.delete(old.tab.worktree);
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
    const live = entries.filter((e) => !ended(e.tab.status));
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

  /** The status a worktree shows, from its agent tabs only. */
  dot(worktree: string): TabStatus | null {
    return worktreeDot(
      this.tabs(worktree)
        .filter((t) => t.agent)
        .map((t) => t.status),
    );
  }

  noteInput(id: string): void {
    this.apply(id, { kind: "input", at: this.now() });
  }

  noteOutput(id: string, bytes: number): void {
    if (bytes > 0) this.apply(id, { kind: "output", at: this.now() });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stops the exit listener and the timer. Tabs are left to their owners. */
  dispose(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.listeners.clear();
    void this.unlisten.then((off) => off()).catch(() => {});
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

  /** Steps one entry; true when its visible status changed. */
  private advance(entry: Entry, event: StatusEvent): boolean {
    const next = step(entry.state, event);
    const changed = next.status !== entry.state.status;
    entry.state = next;
    if (changed) {
      entry.tab = { ...entry.tab, status: next.status, ...(event.kind === "exit" ? { exitCode: event.code } : {}) };
      this.cache.delete(entry.tab.worktree);
      this.emit();
    }
    return changed;
  }

  private entry(worktree: string, profileId: PtyProfile): Entry {
    const id = crypto.randomUUID();
    const tab: Tab = {
      id,
      worktree,
      profileId,
      agent: profileId !== "shell",
      status: "idle",
      client: new PtyClient(this.api, id),
    };
    return { tab, state: { status: "idle", lastInput: 0, lastOutput: 0 } };
  }

  private remove(entries: Entry[]): void {
    for (const e of entries) {
      this.entries.delete(e.tab.id);
      this.cache.delete(e.tab.worktree);
    }
    this.sync();
    this.emit();
  }

  /** The 1 s interval runs only while some tab is working. */
  private sync(): void {
    const working = [...this.entries.values()].some((e) => e.state.status === "working");
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
