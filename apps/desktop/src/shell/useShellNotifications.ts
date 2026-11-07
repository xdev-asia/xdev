import { useEffect, useState } from "react";
import { profileName } from "@/agents/profileStore";
import type { Api, HookDetail, RepoView } from "@/api";
import type { useI18n } from "@/i18n";
import { playStatusSound } from "@/status/sound";
import { eventOn, loadStatusSettings, type useStatusSettings } from "@/status/statusSettings";
import { admits } from "@/workspace/attention";
import { badgeWorktrees, type NeedsYou } from "@/workspace/needsYou";
import { createNotifier, type Notifier } from "@/workspace/notifier";
import type { Attention, Sessions, Tab } from "@/workspace/sessions";
import { worktreeName } from "@/workspace/shellModel";

type T = ReturnType<typeof useI18n>["t"];

/** OS notifications, the taskbar badge and the header inbox: what wants the person, and the way back to it. */
export function useShellNotifications(o: {
  api: Api;
  sessions: Sessions | null;
  statusSettings: ReturnType<typeof useStatusSettings>;
  needs: NeedsYou;
  live: { t: T; jump(id: string): boolean; notifier: Notifier | null; repos: RepoView[] | null };
}) {
  const { api, sessions, statusSettings, needs, live } = o;
  const [inboxOpen, setInboxOpen] = useState(false);

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

  // The taskbar badge counts the worktrees where something waits on the person, for the events that are
  // switched on (none with the master switch off): the same selector as the inbox, the dots and the footer.
  const badgeCount = badgeWorktrees(needs, (status) => eventOn(statusSettings, status));
  useEffect(() => {
    live.notifier?.badge(badgeCount);
  }, [sessions, badgeCount, statusSettings.badge]);
  // A notified tab that is read has its OS notification taken down.
  const counted = (tab: Tab) => admits(tab.unreadReason, statusSettings);
  const unreadKey = (sessions?.unreadTabs() ?? []).filter(counted).map((tab) => tab.id).join(",");
  useEffect(() => {
    live.notifier?.unread(unreadKey ? unreadKey.split(",") : []);
  }, [sessions, unreadKey]);

  // The notification text: the worktree, then the tab by its profile's name or the one given by
  // hand. Never the terminal's own title, which can carry what was typed.
  async function announce(notifier: Notifier, tab: Tab, status: Attention, detail: HookDetail | null): Promise<void> {
    const worktree = worktreeName(live.repos?.flatMap((r) => r.worktrees) ?? [], tab.worktree);
    const name = tab.renamed && tab.title ? tab.title : profileName(await api.profiles().catch(() => null), tab.profileId, live.t);
    await notifier.attention(tab, status, { worktree, tab: name }, detail);
  }

  return { inboxOpen, setInboxOpen };
}
