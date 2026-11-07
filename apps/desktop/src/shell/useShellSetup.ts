import { useRef, useState } from "react";
import { SETUP_PROFILE, toApiError, type Api, type RepoHooks, type RepoView, type ScriptKind } from "@/api";
import type { useI18n } from "@/i18n";
import { openDefaultTabs } from "@/workspace/defaultTabs";
import type { SetupCardState } from "@/workspace/SetupCard";
import { decideSetup, hasPending, pendingLists } from "@/workspace/setupFlow";
import type { SetupGate } from "@/workspace/setupGate";
import type { Sessions } from "@/workspace/sessions";
import type { Removing, SetupCardAt, TrustAsk } from "@/workspace/shellModel";

type T = ReturnType<typeof useI18n>["t"];

/** Setup of a new worktree: the card it shows, the trust prompt for its scripts, and its default tabs. */
export function useShellSetup(o: {
  api: Api;
  t: T;
  sessions: Sessions | null;
  gate: SetupGate;
  repos: RepoView[] | null;
  remove(): Promise<void>;
  setRemoving(next: (r: Removing | null) => Removing | null): void;
}) {
  const { api, t, sessions, gate, repos, remove, setRemoving } = o;
  // Setup: the card a worktree shows, the trust prompt, and the gate that holds agents while setup runs.
  const [cards, setCards] = useState<Record<string, SetupCardAt>>({});
  const [trusting, setTrusting] = useState<TrustAsk | null>(null);

  // Worktrees whose setup flow already ran (made here, or run for a worker); it runs once each.
  const setupRan = useRef(new Set<string>());

  // What a new worktree does about setup. Skip never opens the setup tab; the card choices and a
  // trusted Run policy do.
  async function setupAfterCreate(path: string, repoId: string, listsAsked = false): Promise<void> {
    let hooks: RepoHooks;
    try {
      hooks = await api.repoHooks(path);
    } catch {
      return;
    }
    const todo = decideSetup(hooks);
    // The setup prompt carries the lists; alone, they are asked first and the flow goes on after.
    if (todo.step !== "trust" && !listsAsked && hasPending(pendingLists(hooks))) return askTrust(path, repoId, hooks, false, "lists");
    if (todo.step === "detected") setCards((c) => ({ ...c, [path]: { kind: "detected", command: todo.command, repoId } }));
    else if (todo.step === "ask") setCards((c) => ({ ...c, [path]: { kind: "ask", repoId } }));
    else if (todo.step === "run") startSetup(path, hooks);
    else if (todo.step === "trust") askTrust(path, repoId, hooks, false);
    // No setup will run now: the default tabs open at once.
    else void openTabsFor(path);
  }

  // The default tabs of the repo file, when the person trusted that list; a shell tab each. The hooks are read
  // again so the trust check sees the file as it is now.
  async function openTabsFor(path: string): Promise<void> {
    try {
      const hooks = await api.repoHooks(path);
      if (hooks.tabsTrusted) await openTabsOf(path, hooks);
    } catch {
      // The worktree is made; it just opens without them.
    }
  }

  async function openTabsOf(path: string, hooks: RepoHooks): Promise<void> {
    if (!sessions || hooks.tabs.length === 0) return;
    const pv = await api.profiles();
    const shell = pv.shells.some((s) => s.id === pv.defaultShell) ? pv.defaultShell : pv.shells[0]?.id;
    if (shell) openDefaultTabs(sessions, path, hooks.tabs, shell);
  }

  function startSetup(path: string, hooks: RepoHooks): void {
    if (!sessions) return;
    const tab = sessions.open(path, SETUP_PROFILE);
    sessions.rename(tab.id, t("setup.tab"));
    // The default tabs wait for setup to exit 0; after a failure the card offers them.
    const tabs = hooks.tabsTrusted && hooks.tabs.length > 0 ? () => void openTabsOf(path, hooks).catch(() => {}) : null;
    gate.track(path, tab.id, hooks.waitForSetup, tabs);
    dropCard(path);
  }

  function askTrust(path: string, repoId: string, hooks: RepoHooks, changed: boolean, kind: ScriptKind | "lists" = "setup"): void {
    const script = kind === "lists" ? null : hooks[kind];
    if (kind !== "lists" && !script) return;
    // The archive prompt is about the script alone.
    const lists = kind === "archive" ? pendingLists({ ...hooks, sharedHash: null, tabsHash: null }) : pendingLists(hooks);
    setTrusting({ path, repoId, kind, text: script?.text ?? "", hash: script?.hash ?? "", lists, changed, busy: false });
  }

  // The archive script is not trusted: show its current text, then run the removal again on Trust.
  async function askArchiveTrust(path: string): Promise<void> {
    try {
      const hooks = await api.repoHooks(path);
      const repoId = repos?.find((r) => r.worktrees.some((w) => w.path === path))?.id ?? "";
      askTrust(path, repoId, hooks, false, "archive");
    } catch (e) {
      setRemoving((r) => (r ? { ...r, error: toApiError(e).code } : r));
    }
  }

  // The card's Run setup: the script is read again first, so the trust check sees the file as it is now.
  async function runSetup(path: string, repoId: string): Promise<void> {
    try {
      const hooks = await api.repoHooks(path);
      if (!hooks.setup) return;
      if (hooks.setup.trusted) startSetup(path, hooks);
      else askTrust(path, repoId, hooks, false);
    } catch {
      // The card stays; the person can try again.
    }
  }

  // Trust the text that was shown. A refused hash means the file changed: read it again and show the new text.
  async function confirmTrust(): Promise<void> {
    if (!trusting || trusting.busy) return;
    const ask = trusting;
    setTrusting({ ...ask, busy: true });
    try {
      // The lists first, the script last, so the hooks that come back are the newest.
      let hooks: RepoHooks | null = null;
      if (ask.lists.sharedHash !== null) hooks = await api.repoHookTrust(ask.path, "shared", ask.lists.sharedHash);
      if (ask.lists.tabsHash !== null) hooks = await api.repoHookTrust(ask.path, "tabs", ask.lists.tabsHash);
      if (ask.kind !== "lists") hooks = await api.repoHookTrust(ask.path, ask.kind, ask.hash);
      setTrusting(null);
      if (ask.kind === "setup" && hooks) startSetup(ask.path, hooks);
      else if (ask.kind === "archive") void remove();
      else void setupAfterCreate(ask.path, ask.repoId, true);
    } catch (e) {
      const code = toApiError(e).code;
      if (code !== "hook_untrusted") return setTrusting({ ...ask, busy: false, error: code });
      try {
        const fresh = await api.repoHooks(ask.path);
        const script = ask.kind === "lists" ? null : fresh[ask.kind];
        const lists = ask.kind === "archive" ? ask.lists : pendingLists(fresh);
        if (!script && !hasPending(lists)) return setTrusting(null);
        setTrusting({ ...ask, text: script?.text ?? "", hash: script?.hash ?? "", lists, changed: true, busy: false, error: undefined });
      } catch (again) {
        setTrusting({ ...ask, busy: false, error: toApiError(again).code });
      }
    }
  }

  function dropCard(path: string): void {
    setCards((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== path)));
  }

  // The card of the worktree in front: a held agent beats the offers.
  function cardFor(path: string): SetupCardState | null {
    const held = gate.state(path);
    if (held) return held.phase === "running" ? { kind: "waiting" } : { kind: "failed", code: held.code, agent: held.agent, tabs: held.tabs };
    const card = cards[path];
    return card ? (card.kind === "ask" ? { kind: "ask" } : { kind: "detected", command: card.command }) : null;
  }

  return {
    cards, trusting, setTrusting, setupRan, setupAfterCreate, openTabsFor, startSetup, askArchiveTrust, runSetup, confirmTrust, dropCard, cardFor,
  };
}
