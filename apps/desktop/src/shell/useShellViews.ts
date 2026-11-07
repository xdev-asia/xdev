import { useState } from "react";
import type { AppRequest } from "@/DocsApp";
import type { KitTab } from "@/components/AgentKitView";
import { settingsIntent } from "@/settings/settingsIntent";
import type { View } from "@/workspace/shellModel";

export type SettingsAt = { section?: string; arg?: string; target?: string; seq: number };

/** Which page the shell shows (workspace, docs, settings, automations) and the requests the pages read. */
export function useShellViews() {
  const [view, setView] = useState<View>("workspace");
  // The docs app mounts on first visit and then stays, so its editor state survives a switch.
  const [docsMounted, setDocsMounted] = useState(false);
  // A request for the Agent kit to open a tab; a new `seq` is a new request.
  const [kitOpen, setKitOpen] = useState<{ tab: KitTab; seq: number } | null>(null);
  // A request for the docs view to show one of its apps (the usage popover asks for Accounts).
  const [appRequest, setAppRequest] = useState<AppRequest | null>(null);
  // Bumped when a vault opens from the sidebar, so the docs app boots again on the new folder.
  const [docsKey, setDocsKey] = useState(0);
  // The settings section the palette or a link asked for; a new `seq` is a new request.
  const [settingsAt, setSettingsAt] = useState<SettingsAt>({ seq: 0 });

  function show(next: View): void {
    setView(next);
    if (next === "docs") setDocsMounted(true);
  }

  // `toggle`: asking for the place Settings already shows closes it instead.
  function openSettings(section?: string, arg?: string, target?: string, toggle = false): void {
    const next = settingsIntent(settingsAt, view === "settings", { section, arg, target }, toggle);
    if (next.close) {
      show("workspace");
      return;
    }
    setSettingsAt(next.at);
    show("settings");
  }

  // Usage details & history live on the Stats & Usage settings page; the Kit app keeps its own tab.
  function openUsage(): void {
    openSettings("usage");
  }

  function openTask(id: string): void {
    setAppRequest((r) => ({ app: "tasks", task: id, seq: (r?.seq ?? 0) + 1 }));
    show("docs");
  }

  // The Tasks app on the Board tab, with the editor on a file task when one is named.
  function openTaskBoard(boardTask?: string): void {
    setAppRequest((r) => ({ app: "tasks", tab: "board", boardTask, seq: (r?.seq ?? 0) + 1 }));
    show("docs");
  }

  // The Tasks app on the Board tab with the split-a-goal dialog open.
  function openDecompose(): void {
    setAppRequest((r) => ({ app: "tasks", tab: "board", decompose: true, seq: (r?.seq ?? 0) + 1 }));
    show("docs");
  }

  function openAccounts(): void {
    setAppRequest((r) => ({ app: "accounts", seq: (r?.seq ?? 0) + 1 }));
    show("docs");
  }

  // The Kit shows a request once, then hands it back; a later mount of a host finds none waiting.
  function kitOpened(seq: number): void {
    setKitOpen((k) => (k && k.seq === seq ? null : k));
  }

  // The docs app has the only search for now; it shows after this render, so its box is looked up then.
  function openSearch(): void {
    show("docs");
    setTimeout(() => {
      if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
      const box = document.querySelector<HTMLInputElement>(".ws-docs .search-input");
      box?.focus();
      box?.select();
    }, 0);
  }

  // The docs app marks its status line while the open doc differs from disk; DocsApp.tsx stays as is.
  function docsSaved(): boolean {
    return typeof document === "undefined" || !document.querySelector(".ws-docs .doc-status[data-dirty]");
  }

  return {
    view, show, docsMounted, setDocsMounted, kitOpen, appRequest, docsKey, setDocsKey, settingsAt, setSettingsAt,
    openSettings, openUsage, openTask, openTaskBoard, openDecompose, openAccounts, kitOpened, openSearch, docsSaved,
  };
}
