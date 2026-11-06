import type { Api, ProfilesView, PtyProfile, SessionRow } from "@/api";
import { resumeProfile } from "@/agentSessions/resumeTarget";
import type { PaletteItem } from "@/palette/items";
import type { Sessions, Tab, TabCli } from "@/workspace/sessions";

/** How often a working chat re-reads its transcript, and how often it looks for a session the hooks did not report. */
export const CHAT_POLL_MS = 2000;
/** How long opening a chat waits for the last-session lookup before it opens fresh. */
export const RESUME_LOOKUP_MS = 2000;
/** A chat tab that resumed a session and exits within this time failed to resume it. */
export const RESUME_GRACE_MS = 10_000;

type T = (key: string, vars?: Record<string, string | number>) => string;
type View = "chat" | "terminal";

/** Whether a tab of this cli can show as a chat: only claude and codex have a transcript reader and resume args. */
export function chatCapable(cli: string | null | undefined): cli is "claude" | "codex" {
  return cli === "claude" || cli === "codex";
}

const profileOf = (view: ProfilesView | null, id: string) => view?.profiles.find((p) => p.profile.id === id)?.profile;

/** What a new tab of this profile opens as: chat only for a chat-capable profile set to it. */
export function openAsOf(view: ProfilesView | null, profileId: string): View {
  const p = profileOf(view, profileId);
  return p && chatCapable(p.cli) && p.openAs === "chat" ? "chat" : "terminal";
}

/** A timer the tests can drive: runs `fn` after `ms` and returns the cancel. */
export type After = (fn: () => void, ms: number) => () => void;
const realAfter: After = (fn, ms) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

/**
 * The newest resumable session of `cli` in `worktree` that no tab of that worktree holds, or null: no hit,
 * a failed lookup and a lookup slower than `timeoutMs` all give null.
 */
export function lastSession(
  api: Pick<Api, "agentSessions">,
  sessions: Pick<Sessions, "tabs">,
  worktree: string,
  cli: "claude" | "codex",
  timeoutMs: number = RESUME_LOOKUP_MS,
  after: After = realAfter,
): Promise<SessionRow | null> {
  return new Promise((resolve) => {
    const cancel = after(() => resolve(null), timeoutMs);
    api
      .agentSessions({ text: null, scope: { kind: "worktree", path: worktree }, agent: cli, homeId: null, sort: "firstDesc", limit: 5 }, false)
      .then((rows) => {
        const live = new Set(sessions.tabs(worktree).flatMap((t) => [t.agentSession, t.resumeOf]).filter((s): s is string => !!s));
        resolve(rows.find((r) => r.resumable && !live.has(r.session.id)) ?? null);
      })
      .catch(() => resolve(null))
      .finally(cancel);
  });
}

export interface OpenDeps {
  api: Pick<Api, "agentSessions">;
  sessions: Pick<Sessions, "tabs" | "open" | "resume" | "setView">;
  profiles: ProfilesView | null;
  /** Called just before the tab opens, with `pane`, so the tab lands in the right pane. */
  focusPane?: (pane: string) => void;
  after?: After;
}

/**
 * Opens an agent tab as chat or terminal. `view` overrides the profile's own default. A chat resumes the
 * worktree's last conversation when there is one to take, else starts fresh; a terminal never resumes.
 */
export async function openAgentTab(
  deps: OpenDeps,
  req: { worktree: string; profile: PtyProfile; cli: TabCli; view?: View; pane?: string },
): Promise<Tab> {
  const { worktree, profile, cli, pane } = req;
  const view = chatCapable(cli) ? (req.view ?? openAsOf(deps.profiles, profile)) : "terminal";
  const row = view === "chat" && chatCapable(cli) ? await lastSession(deps.api, deps.sessions, worktree, cli, RESUME_LOOKUP_MS, deps.after) : null;
  if (pane) deps.focusPane?.(pane);
  const tab = row ? deps.sessions.resume(worktree, profile, resumeProfile(row).account, row.session.id, row.session.title, cli) : deps.sessions.open(worktree, profile, null, cli);
  if (view === "chat") deps.sessions.setView(tab.id, "chat");
  return tab;
}

/** The chat tab exited right after it resumed a session: the session is probably gone. */
export function resumeFailed(tab: { view?: "chat"; resumeOf: string | null; exitCode?: number | null; openedAt: number }, now: number): boolean {
  return tab.view === "chat" && tab.resumeOf !== null && tab.exitCode !== undefined && now - tab.openedAt < RESUME_GRACE_MS;
}

/** The palette items that open an agent as chat or terminal and switch the front tab between them. */
export function chatTabItems(
  t: T,
  o: {
    profiles: ProfilesView | null;
    front: { id: string; agent: boolean; cli: TabCli } | null | undefined;
    name: (profileId: string) => string;
    open: (profileId: string, cli: TabCli, view: View) => void;
    toggle: (tabId: string) => void;
  },
): PaletteItem[] {
  const keywords = t("chat.palette.keywords").split(/\s+/).filter(Boolean);
  const items: PaletteItem[] = [];
  for (const { profile: p } of o.profiles?.profiles ?? []) {
    if (!p.enabled || !chatCapable(p.cli)) continue;
    const cli = p.cli;
    items.push({ id: `chat:open:${p.id}`, kind: "action", title: t("chat.palette.open", { name: o.name(p.id) }), keywords, run: () => o.open(p.id, cli, "chat") });
    if (p.openAs === "chat") items.push({ id: `chat:terminal:${p.id}`, kind: "action", title: t("chat.palette.openTerminal", { name: o.name(p.id) }), keywords, run: () => o.open(p.id, cli, "terminal") });
  }
  const front = o.front;
  if (front && front.agent && chatCapable(front.cli)) {
    const id = front.id;
    items.push({ id: "chat:toggle", kind: "action", title: t("chat.palette.toggle"), keywords, run: () => o.toggle(id) });
  }
  return items;
}
