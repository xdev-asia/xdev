import { useEffect, useState } from "react";
import type { Api } from "@/api";
import type { ActivityFeed } from "@/activity/feed";
import type { useI18n } from "@/i18n";
import { startBusyReport } from "@/stats/busyReport";
import { startKeepAwakeReport } from "@/status/keepAwake";
import { startNotchReport } from "@/notch/notchReport";
import { usePresence } from "@/status/presence";
import { loadStatusSettings, type useStatusSettings } from "@/status/statusSettings";
import type { Sessions } from "@/workspace/sessions";
import { windowFocused, type View } from "@/workspace/shellModel";

type T = ReturnType<typeof useI18n>["t"];

/** What runs beside the window while it is open: what is seen, the activity feed, and the reports to the backend. */
export function useShellServices(o: {
  api: Api;
  sessions: Sessions | null;
  view: View;
  current: { path: string } | null;
  panes: Record<string, string[]>;
  statusSettings: ReturnType<typeof useStatusSettings>;
  feed: ActivityFeed;
  live: { t: T };
}): void {
  const { api, sessions, view, current, panes, statusSettings, feed, live } = o;
  // The window has the person: focused and not minimised. Only then is a pane on screen seen.
  const [focused, setFocused] = useState(windowFocused);
  // Focus and visibility decide what is seen; a minimised or background window sees nothing.
  useEffect(() => {
    const update = () => setFocused(windowFocused());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", update);
    };
  }, []);

  // The panes the person looks at: the selected worktree's front pair, with the workspace up, the window
  // focused and some trusted input in the last 180 s.
  const present = usePresence();
  const seenKey = focused && present && view === "workspace" && current ? (panes[current.path] ?? []).join(" ") : "";
  useEffect(() => {
    sessions?.setSeen(seenKey ? seenKey.split(" ") : []);
  }, [sessions, seenKey]);

  // Settings stores its own switches; they are read again on leaving it, on coming back to the window
  // and before every notification, so a change there applies without a restart.
  useEffect(() => {
    void loadStatusSettings(api);
  }, [api, view, focused]);

  // With hooks off the marker drops every hook event, so open panes go back to timing.
  useEffect(() => {
    sessions?.setHooks(statusSettings.hooks);
  }, [sessions, statusSettings.hooks]);

  // The Activity feed records every status change of the agent tabs.
  useEffect(() => {
    if (!sessions) return;
    return feed.follow(sessions);
  }, [feed, sessions]);

  // Whether an agent works, for the keep-awake mode "while agents work".
  useEffect(() => {
    if (!sessions) return;
    return startKeepAwakeReport(api, sessions);
  }, [api, sessions]);

  // The time agents work, for the counters on Settings → Stats & Usage.
  useEffect(() => {
    if (!sessions) return;
    return startBusyReport(api, sessions);
  }, [api, sessions]);

  // The agent tabs for the macOS status strip at the notch; the backend picks what it shows.
  useEffect(() => {
    if (!sessions) return;
    return startNotchReport(api, sessions, (key, vars) => live.t(key, vars));
  }, [api, sessions]);
}
