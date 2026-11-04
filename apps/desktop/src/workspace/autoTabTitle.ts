import { toApiError, type Api } from "@/api";
import type { Sessions } from "./sessions";

/** A prompt the session index has not read yet has no title; the next change of the tabs may find it. */
const NOT_READ_TRIES = 3;
const MAX_WORDS = 6;
const MAX_CHARS = 40;
/** Control characters (line breaks stay) and bidi / zero-width marks never reach a tab title. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
/** A run of 32 or more letters, digits, dash and underscore with both a letter and a digit looks like a key, token or sha. */
const TOKEN_LIKE = /(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/g;

/**
 * A short tab title from a prompt: its first non-blank line with the white space folded, at most six
 * words and forty characters, an ellipsis when something was cut. Blank gives `null`.
 */
export function tabTitleFromPrompt(prompt: string | null | undefined): string | null {
  const clean = (prompt ?? "").replace(CONTROL, "");
  const line = clean.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).find((l) => l !== "");
  if (!line) return null;
  const words = line.split(" ").map((w) => w.replace(TOKEN_LIKE, "…"));
  let text = words.slice(0, MAX_WORDS).join(" ");
  let cut = words.length > MAX_WORDS;
  const points = Array.from(text);
  if (points.length > MAX_CHARS) {
    // The ellipsis counts in the forty; the cut falls between code points, never inside a surrogate pair.
    text = points.slice(0, MAX_CHARS - 1).join("").trimEnd();
    cut = true;
  }
  return cut ? `${text}…` : text;
}

export interface AutoTabTitleDeps {
  api: Pick<Api, "agentsSettings" | "agentSessions">;
  sessions: Pick<Sessions, "worktrees" | "tabs" | "tab" | "subscribe" | "setAutoTitle">;
}

/**
 * Titles an agent tab from the first prompt of its session: the first time a tab of this run is
 * working with a session id, and Settings → Agents has the option on (read when the lookup starts),
 * the session index gives the prompt and `Sessions.setAutoTitle` shows its short form. A tab named by
 * hand is left alone. Once per tab per run, except that a prompt the index has not read yet is asked
 * for again on the next changes, three times in all. A failure is silent (logged once). Returns the stop.
 */
export function startAutoTabTitle(deps: AutoTabTitleDeps): () => void {
  const { api, sessions } = deps;
  const tried = new Set<string>();
  const unread = new Map<string, number>();
  let logged = false;
  let stopped = false;

  const open = (id: string) => {
    const live = sessions.tab(id);
    return live && !live.renamed && !live.autoTitled ? live : null;
  };

  async function run(id: string, worktree: string, session: string): Promise<void> {
    try {
      const setting = await api.agentsSettings();
      if (stopped || !setting.autoTabTitle || !open(id)) return;
      const rows = await api.agentSessions({ text: session, scope: { kind: "worktree", path: worktree }, agent: null, homeId: null, sort: "lastDesc", limit: 1 }, true);
      if (stopped || !open(id)) return;
      const title = tabTitleFromPrompt(rows.find((r) => r.session.id === session)?.session.title);
      if (title === null) {
        const n = (unread.get(id) ?? 0) + 1;
        unread.set(id, n);
        if (n < NOT_READ_TRIES) tried.delete(id);
        return;
      }
      sessions.setAutoTitle(id, title);
    } catch (e) {
      if (!logged) {
        logged = true;
        console.warn("auto tab title failed:", toApiError(e).code);
      }
    }
  }

  const look = (): void => {
    if (stopped) return;
    for (const worktree of sessions.worktrees()) {
      for (const tab of sessions.tabs(worktree)) {
        if (!tab.agent || tab.status !== "working" || !tab.agentSession || tab.renamed || tab.autoTitled || tried.has(tab.id)) continue;
        tried.add(tab.id);
        void run(tab.id, worktree, tab.agentSession);
      }
    }
  };
  const off = sessions.subscribe(look);
  return () => {
    stopped = true;
    off();
  };
}
