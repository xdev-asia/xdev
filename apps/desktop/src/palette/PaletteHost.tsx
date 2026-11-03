import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useProfiles, profileName } from "@/agents/profileStore";
import type { RepoView, WorktreeView } from "@/api";
import { useI18n } from "@/i18n";
import type { Sessions } from "@/workspace/sessions";
import { actionItems, settingItems, tabItems, worktreeItems, type ActionName, type Attention, type PaletteItem } from "./items";
import { JumpPalette } from "./JumpPalette";
import { RecentStore } from "./recent";

/** What the palette can make the shell do; the shell supplies each one. */
export interface PaletteActions {
  /** Selects the worktree and shows the workspace view. */
  selectWorktree(wt: WorktreeView): void;
  /** Brings a tab to the front of its worktree. */
  frontTab(worktree: string, id: string): void;
  openSettings(section?: string): void;
  newWorktree(name?: string): void;
  addRepo(): void;
  searchDocs(): void;
  toggleSidebar(): void;
  showDocs(): void;
}

export interface PaletteHostProps {
  open: boolean;
  onClose(): void;
  repos: RepoView[] | null;
  sessions: Sessions | null;
  current: WorktreeView | null;
  /** The tab in front of the current worktree. */
  shownTab: string | null;
  /** Optional: what an agent wants from the person, so those tabs rank first. */
  attention?: (tabId: string) => Attention | null;
  actions: PaletteActions;
}

const FALLBACK_AGENT = "claude";
const FALLBACK_SHELL = "shell";

/** Turns the shell's state into palette items and keeps the recency of what was visited. */
export function PaletteHost(props: PaletteHostProps): JSX.Element {
  const { open, repos, sessions, current, shownTab, attention, actions } = props;
  const { t } = useI18n();
  const { view } = useProfiles();
  const [recent] = useState(() => new RecentStore());

  const currentPath = current?.path ?? null;
  useEffect(() => {
    if (currentPath) recent.touch(`wt:${currentPath}`);
  }, [currentPath]);
  useEffect(() => {
    if (shownTab && !shownTab.startsWith("file:")) recent.touch(`tab:${shownTab}`);
  }, [shownTab]);

  const list = repos ?? [];
  const usable = list.some((r) => !r.missing);

  function openTab(profile: string): void {
    if (!sessions || !current) return;
    const tab = sessions.open(current.path, profile);
    actions.frontTab(current.path, tab.id);
  }

  let items: PaletteItem[] = [];
  if (open) {
    const handlers: Partial<Record<ActionName, () => void>> = {
      newWorktree: usable ? () => actions.newWorktree() : undefined,
      newAgentTab: sessions && current ? () => openTab(view?.defaultAgent ?? FALLBACK_AGENT) : undefined,
      newShellTab: sessions && current ? () => openTab(view?.shells[0]?.id ?? FALLBACK_SHELL) : undefined,
      addRepo: () => actions.addRepo(),
      openSettings: () => actions.openSettings(),
      searchDocs: () => actions.searchDocs(),
      toggleSidebar: () => actions.toggleSidebar(),
      showDocs: () => actions.showDocs(),
    };
    const worktreeOf = (path: string) => list.flatMap((r) => r.worktrees).find((w) => w.path === path);
    items = [
      ...tabItems(list, (path) => sessions?.tabs(path) ?? [], {
        name: (tab) => profileName(view, tab.profileId, t),
        attention,
        onPick: (tab) => {
          const wt = worktreeOf(tab.worktree);
          if (!wt) return;
          actions.selectWorktree(wt);
          actions.frontTab(wt.path, tab.id);
        },
      }),
      ...worktreeItems(list, {
        dot: (path) => sessions?.dot(path) ?? null,
        activity: (path) => sessions?.lastActivity(path) ?? null,
        detached: t("workspace.detached"),
        onPick: (wt) => actions.selectWorktree(wt),
      }),
      ...settingItems(t, (id) => actions.openSettings(id)),
      ...actionItems(t, handlers),
    ];
  }

  return (
    <JumpPalette
      open={open}
      items={items}
      current={{ worktree: currentPath, tab: shownTab }}
      recent={recent}
      canCreate={usable}
      onCreate={(name) => actions.newWorktree(name)}
      onClose={props.onClose}
    />
  );
}
