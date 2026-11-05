import type { ApiError, LaunchOverrides, PtyProfile, SequenceStep, SetEntry, TerminalSet } from "@/api";
import { ready, AGENT_START_MS } from "@/workspace/agentPrompt";
import type { Sessions, Tab } from "@/workspace/sessions";
import { runBatch, STAGGER_MS, type BatchProgress } from "./batch";
import { waitIdle } from "./idle";
import { runSequence, type SequenceResult } from "./sequence";
import { rememberStartup } from "./startupMemory";
import { resolveWorktree } from "./sets";

/** How long after the last spawn a late start error still counts for the batch. */
export const SPAWN_GRACE_MS = 2_000;

type SessionsPart = Pick<Sessions, "open" | "tabs" | "subscribe" | "close">;

/** Types a sequence into `tab`. An agent is given time to start first; a shell queues the text until its pty runs. */
export async function startSequence(sessions: SessionsPart, tab: Tab, steps: readonly SequenceStep[], timeoutMs = AGENT_START_MS): Promise<SequenceResult> {
  if (steps.length === 0) return { status: "done", ran: 0 };
  const find = () => sessions.tabs(tab.worktree).find((t) => t.id === tab.id);
  let live: Tab | undefined = tab;
  if (tab.agent) {
    live = (await ready(sessions as Sessions, tab.worktree, tab.id, timeoutMs)) ?? undefined;
    if (!live) return { status: "failed", ran: 0, at: 0 };
  }
  const client = live.client;
  return runSequence(steps, {
    write: (bytes) => {
      if (client.spawned) return client.input(bytes);
      client.typeWhenReady(bytes);
      return Promise.resolve();
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    idle: () => waitIdle({ subscribe: (l) => sessions.subscribe(l), find }),
    cancelled: () => find() === undefined,
  });
}

/** What opening copies or a set needs from the window. */
export interface OpenContext {
  sessions: SessionsPart;
  /** The worktree the launch is in. */
  worktree: string;
  worktrees: readonly { path: string; label: string }[];
  /** The shell a plain shell entry opens; null when none is on. */
  defaultShell: PtyProfile | null;
  /** Told when a startup sequence ended: by what it ran for (`index` of the copy or entry). */
  onSequence?(index: number, result: SequenceResult): void;
  /** Overrides for tests. */
  staggerMs?: number;
  graceMs?: number;
  sleep?(ms: number): Promise<void>;
  onProgress?(p: BatchProgress): void;
}

/** A start error that is a real failure: an approval is asked for in the tab itself. */
const fails = (e: ApiError): boolean => e.code !== "needs_approval";

/**
 * Runs `open(i)` for each index, staggered, and watches each new tab for a start error. Resolves once the
 * last spawn was made and the grace time passed, with every index that failed (a thrown open or a start
 * error). `tabs` has the tab opened for each index, to close before a retry.
 */
export function openMany(
  indexes: readonly number[],
  open: (index: number) => Tab,
  ctx: Pick<OpenContext, "staggerMs" | "graceMs" | "sleep" | "onProgress">,
): { done: Promise<BatchProgress>; tabs: Map<number, Tab> } {
  const tabs = new Map<number, Tab>();
  const late = new Set<number>();
  const offs: Array<() => void> = [];
  let last: BatchProgress = { tried: 0, total: indexes.length, failed: [] };
  const merged = (p: BatchProgress): BatchProgress => ({ ...p, failed: [...new Set([...p.failed, ...late])].sort((a, b) => a - b) });
  const report = (p: BatchProgress) => {
    last = p;
    ctx.onProgress?.(merged(p));
  };
  const done = (async () => {
    const batch = await runBatch(
      indexes,
      (i) => {
        const tab = open(i);
        tabs.set(i, tab);
        const err = tab.client.startError;
        if (err && fails(err)) late.add(i);
        offs.push(
          tab.client.onStartError((e) => {
            if (!fails(e)) return;
            late.add(i);
            report(last);
          }),
        );
      },
      { staggerMs: ctx.staggerMs ?? STAGGER_MS, ...(ctx.sleep ? { sleep: ctx.sleep } : {}), onProgress: report },
    );
    await (ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(ctx.graceMs ?? SPAWN_GRACE_MS);
    for (const off of offs) off();
    const out = merged(batch);
    ctx.onProgress?.(out);
    return out;
  })();
  return { done, tabs };
}

/** Copies of one agent: what each carries besides the profile. */
export interface CopyChoice {
  profile: PtyProfile;
  worktree: string;
  prompt: string | null;
  overrides: LaunchOverrides | null;
  startup: readonly SequenceStep[];
}

/** Opens one tab of a launch with its first prompt and overrides, and starts its startup sequence. */
export function openCopy(ctx: OpenContext, choice: CopyChoice, cli: Tab["cli"] | undefined, index: number): Tab {
  const tab = ctx.sessions.open(choice.worktree, choice.profile, null, cli, {
    ...(choice.prompt === null ? {} : { prompt: choice.prompt }),
    ...(choice.overrides === null ? {} : { overrides: choice.overrides }),
  });
  rememberStartup(tab.id, choice.startup);
  if (choice.startup.length > 0) void startSequence(ctx.sessions, tab, choice.startup).then((r) => ctx.onSequence?.(index, r));
  return tab;
}

/** Opens one entry of a set; throws `worktree` or `shell` when it cannot (the message is the reason). */
export function openEntry(ctx: OpenContext, entry: SetEntry, index: number): Tab {
  const path = resolveWorktree(entry.worktree, ctx.worktree, ctx.worktrees);
  if (path === null) throw new Error("worktree");
  let profile: PtyProfile;
  let steps: SequenceStep[] = entry.startup;
  if (entry.target.type === "agent") profile = entry.target.profile;
  else {
    const shell = entry.target.shell ?? ctx.defaultShell;
    if (shell === null) throw new Error("shell");
    profile = shell;
    if (entry.target.command.trim() !== "") steps = [{ command: entry.target.command, wait: { type: "none" } }, ...entry.startup];
  }
  const tab = ctx.sessions.open(path, profile, null, undefined);
  rememberStartup(tab.id, entry.startup);
  if (steps.length > 0) void startSequence(ctx.sessions, tab, steps).then((r) => ctx.onSequence?.(index, r));
  return tab;
}

/** Opens the entries of `set` listed in `only` (all when left out), staggered. */
export function openSet(ctx: OpenContext, set: TerminalSet, only?: readonly number[]) {
  const indexes = only ?? set.entries.map((_, i) => i);
  return openMany(indexes, (i) => openEntry(ctx, set.entries[i], i), ctx);
}
