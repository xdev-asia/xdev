import { useEffect, useState } from "react";
import { profileName } from "@/agents/profileStore";
import type { Api, HookDetail, RepoView, WorktreeView } from "@/api";
import type { useI18n } from "@/i18n";
import { playStatusSound } from "@/status/sound";
import { loadStatusSettings, type useStatusSettings } from "@/status/statusSettings";
import { admits } from "@/workspace/attention";
import type { BellRow } from "@/workspace/BellMenu";
import { createNotifier, type Notifier } from "@/workspace/notifier";
import type { Attention, Sessions, Tab } from "@/workspace/sessions";
import { worktreeName } from "@/workspace/shellModel";

type T = ReturnType<typeof useI18n>["t"];

/** OS notifications, the taskbar badge and the bell: what wants the person, and the way back to it. */
export function useShellNotifications(o: {
  api: Api;
  sessions: Sessions | null;
  statusSettings: ReturnType<typeof useStatusSettings>;
  all: WorktreeView[];
  t: T;
  live: { t: T; jump(id: string): boolean; notifier: Notifier | null; repos: RepoView[] | null };
}) {
  const { api, sessions, statusSettings, all, t, live } = o;
  const [bellOpen, setBellOpen] = useState(false);

  // A pane nobody looks at that wants the person: OS notification, sound, and the jump back on a click.
  useEffect(() => {
    if (!sessions) return;
    const notifier = createNotifier({
      api,
      settings: () => loadStatusSettings(api),
      play: (settings, now) => playStatusSound(api, settings, now),
      now: () => Date.now(),
      t: (key, vars) => live.t(key, vars),
    });
    live.notifier = notifier;
    const offAttention = sessions.onAttention((tab, status, detail) => void announce(notifier, tab, status, detail));
    let closed = false;
    let offClick: (() => void) | null = null;
    api
      .onStatusNotificationClick((id) => {
        notifier.cancelFocusJump();
        live.jump(id);
      })
      .then((off) => {
        if (closed) off();
        else offClick = off;
      })
      .catch(() => {});
    // A click on a toast does not always reach the app (on Windows only while it is on screen), but
    // the window does get the focus: one soon after a notification goes to its pane, unless the
    // person clicked in the app first.
    const onFocus = () => {
      const id = notifier.takeFocusJump(Date.now());
      if (id) live.jump(id);
    };
    const onPointer = () => notifier.cancelFocusJump();
    window.addEventListener("focus", onFocus);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      closed = true;
      offClick?.();
      offAttention();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pointerdown", onPointer, true);
      notifier.dispose();
      if (live.notifier === notifier) live.notifier = null;
    };
  }, [api, sessions]);

  // The bell lists the unread tabs and the taskbar badge counts the unread worktrees, both only for the
  // events that are switched on (and none with the master switch off).
  const counted = (tab: Tab) => admits(tab.unreadReason, statusSettings);
  const unreadTabs = (sessions?.unreadTabs() ?? []).filter(counted);
  const unreadCount = statusSettings.enabled ? (sessions?.unreadWorktrees(counted).length ?? 0) : 0;
  useEffect(() => {
    live.notifier?.badge(unreadCount);
  }, [sessions, unreadCount, statusSettings.badge]);
  // A notified tab that is read has its OS notification taken down.
  const unreadKey = unreadTabs.map((tab) => tab.id).join(",");
  useEffect(() => {
    live.notifier?.unread(unreadKey ? unreadKey.split(",") : []);
  }, [sessions, unreadKey]);
  const bellRows: BellRow[] = unreadTabs.map((tab) => ({
    tab,
    worktree: worktreeName(all, tab.worktree),
    name: tab.title ?? profileName(null, tab.profileId, t),
  }));

  // The notification text: the worktree, then the tab by its profile's name or the one given by
  // hand. Never the terminal's own title, which can carry what was typed.
  async function announce(notifier: Notifier, tab: Tab, status: Attention, detail: HookDetail | null): Promise<void> {
    const worktree = worktreeName(live.repos?.flatMap((r) => r.worktrees) ?? [], tab.worktree);
    const name = tab.renamed && tab.title ? tab.title : profileName(await api.profiles().catch(() => null), tab.profileId, live.t);
    await notifier.attention(tab, status, { worktree, tab: name }, detail);
  }

  function toggleBell(): void {
    const next = !bellOpen;
    setBellOpen(next);
    if (!next) return;
    setTimeout(() => {
      if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
      document.querySelector<HTMLElement>(".ws-bell-pop [role=menuitem], .ws-bell-pop")?.focus();
    }, 0);
  }

  return { bellOpen, setBellOpen, toggleBell, unreadCount, bellRows };
}
