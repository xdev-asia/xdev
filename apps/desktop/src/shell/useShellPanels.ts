import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, IssuesPreset, WorktreeChange } from "@/api";
import { onTreeReveal } from "@/files/treeReveal";
import type { ChangesHandlers } from "@/workspace/WorktreeChanges";
import type { PanelTab, View } from "@/workspace/shellModel";

/** The right panel: which tab shows, whether it is open, and what its panels report back to the shell. */
export function useShellPanels(o: { api: Api; view: View; show(view: View): void; setSidebarOpen(open: boolean): void }) {
  const { api, view, show, setSidebarOpen } = o;
  // The right panel (Files / Changes / Checks); hidden, not unmounted, so its state stays.
  const [rightOpen, setRightOpen] = useState(true);
  // The mounted changes panel's bulk actions, for the palette.
  const changesHandlers = useRef<ChangesHandlers | null>(null);
  const [changesReady, setChangesReady] = useState(false);
  const registerChanges = useCallback((h: ChangesHandlers | null) => {
    changesHandlers.current = h;
    setChangesReady(h !== null);
  }, []);
  // How many files the Changes panel last listed, for the worktree it listed them for.
  const [changeCount, setChangeCount] = useState<{ worktree: string; count: number } | null>(null);
  // The files the Changes panel last listed; the Files tree marks them.
  const [changeList, setChangeList] = useState<{ worktree: string; list: WorktreeChange[] } | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("files");
  // Settings → Git: where the Issues panel opens, and whether its tab shows. The shortcut pins the tab for the session.
  const [issuesGit, setIssuesGit] = useState<{ preset: IssuesPreset; tab: boolean }>({ preset: "all", tab: true });
  const [issuesPinned, setIssuesPinned] = useState(false);
  // A new value asks the search tab for the keyboard.
  const [searchFocus, setSearchFocus] = useState(0);
  // "Open full view" and the palette open the pull request as a page among the worktree's tabs.
  const [prPage, setPrPage] = useState<{ worktree: string; seq: number } | null>(null);

  // "Reveal in file tree" from an editor tab shows the files panel.
  useEffect(() => onTreeReveal(() => { setRightOpen(true); setPanelTab("files"); }), []);
  // Read on start and again when the person comes back from Settings.
  useEffect(() => {
    if (view === "settings") return;
    api.gitSettings().then(
      (git) => setIssuesGit({ preset: git.issuesDefaultView, tab: git.showIssuesTab }),
      () => undefined,
    );
  }, [api, view]);

  const runOnChanges = (run: (h: ChangesHandlers) => void) => {
    setSidebarOpen(true);
    setPanelTab("changes");
    if (changesHandlers.current) run(changesHandlers.current);
  };

  // A panel key shows that tab of the right panel; pressed again on the tab in front, it closes the panel.
  function panelKey(tab: PanelTab): void {
    show("workspace");
    if (rightOpen && panelTab === tab) {
      setRightOpen(false);
      return;
    }
    setRightOpen(true);
    setPanelTab(tab);
    if (tab === "issues") setIssuesPinned(true);
  }

  // The PR chip and the palette open the pull request panel; unlike a panel key, a second ask keeps it open.
  function openPrTab(): void {
    show("workspace");
    setRightOpen(true);
    setPanelTab("pr");
  }

  function openPrPage(worktree: string | null): void {
    show("workspace");
    if (worktree) setPrPage((p) => ({ worktree, seq: (p?.seq ?? 0) + 1 }));
  }

  // The search tab in front, with the keyboard in its box.
  function focusSearch(): void {
    setPanelTab("search");
    setSearchFocus((n) => n + 1);
  }

  return {
    rightOpen, setRightOpen, changesReady, registerChanges, runOnChanges, panelTab, setPanelTab, issuesGit, issuesPinned,
    searchFocus, focusSearch, prPage, panelKey, openPrTab, openPrPage, changeCount, setChangeCount, changeList, setChangeList,
  };
}
