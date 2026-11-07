import { useState } from "react";
import { DOCS_SEARCH_ID } from "@/docs/ids";
import { settingsIntent } from "@/settings/settingsIntent";
import type { BoardTab } from "@/tasks/board/BoardHost";
import type { View } from "@/workspace/shellModel";
import type { DocsSection, Place } from "./places";

export type SettingsAt = { section?: string; arg?: string; target?: string; seq: number };

/** A request for the Tasks place; a new `seq` is a new request and remounts the board on it. */
export type TasksRequest = { seq: number; /** An agent task to show on the Runs tab. */ task?: string; tab?: BoardTab; /** A file task to open in the editor. */ boardTask?: string; /** Open the split-a-goal dialog. */ decompose?: boolean };

/** A request for the Docs place to show one of its sections. */
/** `open` is a doc path (in the docs folder) to open in the Docs section. */
export type DocsRequest = { seq: number; section: DocsSection; open?: string };

/** Which place the shell shows (workspace, docs, tasks, squads, kit, accounts, automations, settings) and the requests the places read. */
export function useShellViews() {
  const [view, setView] = useState<View>("workspace");
  // A place mounts on first show and then stays, so its state survives a switch.
  const [mounted, setMounted] = useState<ReadonlySet<Place>>(() => new Set<Place>(["workspace"]));
  // A request for the Tasks place (a task, a tab, a file task, the decompose dialog).
  const [tasksRequest, setTasksRequest] = useState<TasksRequest | null>(null);
  // A request for the Docs place to show a section (the Kit asks for Agent context, the footer for Changes).
  const [docsRequest, setDocsRequest] = useState<DocsRequest | null>(null);
  // Bumped when a vault opens from the sidebar, so the docs host boots again on the new folder.
  const [docsKey, setDocsKey] = useState(0);
  // The settings section the palette or a link asked for; a new `seq` is a new request.
  const [settingsAt, setSettingsAt] = useState<SettingsAt>({ seq: 0 });

  function show(next: View): void {
    setView(next);
    setMounted((m) => (m.has(next) ? m : new Set(m).add(next)));
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
    setTasksRequest((r) => ({ task: id, seq: (r?.seq ?? 0) + 1 }));
    show("tasks");
  }

  // The Tasks place on the Board tab, with the editor on a file task when one is named.
  function openTaskBoard(boardTask?: string): void {
    setTasksRequest((r) => ({ tab: "board", boardTask, seq: (r?.seq ?? 0) + 1 }));
    show("tasks");
  }

  // The Tasks place on the Board tab with the split-a-goal dialog open.
  function openDecompose(): void {
    setTasksRequest((r) => ({ tab: "board", decompose: true, seq: (r?.seq ?? 0) + 1 }));
    show("tasks");
  }

  function openAccounts(): void {
    show("accounts");
  }

  // The Docs place on one of its sections.
  function openDocsSection(section: DocsSection): void {
    setDocsRequest((r) => ({ section, seq: (r?.seq ?? 0) + 1 }));
    show("docs");
  }

  // The Docs place with one doc open, as picked from the palette's Docs filter.
  function openDoc(path: string): void {
    setDocsRequest((r) => ({ section: "docs", open: path, seq: (r?.seq ?? 0) + 1 }));
    show("docs");
  }

  // The docs search is a field in the Docs side list; it shows after this render, so it is looked up then.
  // Narrow: the side list is a drawer, so it opens first.
  function openSearch(narrow = false, openNav?: () => void): void {
    show("docs");
    if (narrow) openNav?.();
    setTimeout(() => {
      if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
      const box = document.getElementById(DOCS_SEARCH_ID) as HTMLInputElement | null;
      box?.focus();
      box?.select();
    }, 0);
  }

  return {
    view, show, mounted, tasksRequest, docsRequest, openDocsSection, docsKey, setDocsKey, settingsAt, setSettingsAt,
    openSettings, openUsage, openTask, openTaskBoard, openDecompose, openAccounts, openSearch, openDoc,
  };
}
