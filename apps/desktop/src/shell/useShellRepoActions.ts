import { useState } from "react";
import { toApiError, type Api, type ApiError, type Created, type DetailsPatch, type FolderEntry, type RepoView, type SidebarPrefs, type WorktreeView } from "@/api";
import type { useI18n } from "@/i18n";
import { addFoldersNotice, addRepoFolders } from "@/workspace/addFolders";
import { removeRepo } from "@/workspace/removeRepo";
import type { Sessions } from "@/workspace/sessions";
import type { Editing, View } from "@/workspace/shellModel";
import { pushToast } from "@/workspace/toastStore";

type T = ReturnType<typeof useI18n>["t"];

/** The sidebar's own actions: add and forget projects, groups and folders, pin, adopt and edit worktree details. */
export function useShellRepoActions(o: {
  api: Api;
  t: T;
  sessions: Sessions | null;
  load(): Promise<unknown>;
  setNotice(code: ApiError["code"] | undefined): void;
  setPrefs(next: SidebarPrefs): void;
  select(wt: WorktreeView): void;
  show(view: View): void;
}) {
  const { api, t, sessions, load, setNotice, setPrefs, select, show } = o;
  // The group name dialog: `id` null makes a new group.

  const [groupName, setGroupName] = useState<{ id: string | null; name: string; error?: ApiError["code"] } | null>(null);

  const [editing, setEditing] = useState<Editing | null>(null);

  // The repo Remove from xDev asks about, and why the last try failed.
  const [forgetting, setForgetting] = useState<{ repo: RepoView; error?: ApiError["code"] } | null>(null);
  // The Add project dialog (Open folder… or Clone from URL).
  const [adding, setAdding] = useState(false);
  // Add project opened by the palette's remote action starts on its remote step.
  const [addingRemote, setAddingRemote] = useState(false);
  // The folder the Add project dialog opens scanning, when a picked folder held no repo itself.
  const [scanRoot, setScanRoot] = useState<string>();

  async function forgetRepo(repo: RepoView): Promise<void> {
    const code = await removeRepo({ forget: (id) => api.repoForget(id), closeWorktree: (path) => sessions?.closeWorktree(path) }, repo);
    if (code) return setForgetting({ repo, error: code });
    setForgetting(null);
    await load();
  }

  function addRepo(): void {
    setAddingRemote(false);
    setNotice(undefined);
    setScanRoot(undefined);
    setAdding(true);
  }

  async function addRepoFolder(): Promise<void> {
    setAdding(false);
    setNotice(undefined);
    const paths = await api.pickFolders().catch(() => [] as string[]);
    if (paths.length === 0) return;
    await addPaths(paths, true);
  }

  /** Adds the folders, selects the first new worktree and says what failed. A lone folder that is no repo opens the scan step instead. */
  async function addPaths(paths: string[], offerScan: boolean): Promise<void> {
    const result = await addRepoFolders(api, paths);
    await load();
    const first = result.added[0]?.worktrees[0];
    if (first) select(first);
    if (offerScan && paths.length === 1 && result.failed[0]?.code === "no_repo") {
      setScanRoot(paths[0]);
      setAdding(true);
      return;
    }
    const notice = addFoldersNotice(result, paths.length);
    if (notice === null) return;
    if ("code" in notice) setNotice(notice.code);
    else pushToast({ text: t("addProject.openFolders.partial", notice.toast) });
  }

  async function addScanned(paths: string[]): Promise<void> {
    setAdding(false);
    setScanRoot(undefined);
    setNotice(undefined);
    await addPaths(paths, false);
  }

  async function sidebarCall(run: () => Promise<unknown>): Promise<boolean> {
    setNotice(undefined);
    try {
      await run();
      await load();
      return true;
    } catch (e) {
      setNotice(toApiError(e).code);
      return false;
    }
  }

  function changePrefs(next: SidebarPrefs): void {
    setPrefs(next);
    api.sidebarPrefsPut(next).catch((e) => setNotice(toApiError(e).code));
  }

  async function saveGroup(name: string): Promise<void> {
    if (!groupName) return;
    try {
      await api.groupPut(groupName.id, name);
      setGroupName(null);
      await load();
    } catch (e) {
      setGroupName({ ...groupName, name, error: toApiError(e).code });
    }
  }

  async function addFolder(): Promise<void> {
    const path = await api.pickFolder().catch(() => null);
    if (path) await sidebarCall(() => api.folderAdd(path));
  }

  async function openFolder(folder: FolderEntry): Promise<void> {
    if (!sessions) return;
    try {
      const pv = await api.profiles();
      const shell = pv.shells.some((s) => s.id === pv.defaultShell) ? pv.defaultShell : pv.shells[0]?.id;
      if (shell) {
        sessions.open(folder.path, shell);
        show("workspace");
      }
    } catch {
      // The profile list did not load; nothing opens.
    }
  }

  async function repoCloned(repo: RepoView): Promise<void> {
    setAdding(false);
    await load();
    if (repo.worktrees[0]) select(repo.worktrees[0]);
  }

  // A Git project is added and selected like a clone; a folder shows in the sidebar.
  async function projectCreated(created: Created): Promise<void> {
    setAdding(false);
    await load();
    if (created.kind === "git" && created.repo.worktrees[0]) select(created.repo.worktrees[0]);
  }

  async function pin(wt: WorktreeView): Promise<void> {
    setNotice(undefined);
    try {
      await api.worktreePin(wt.path, !wt.pinned);
      await load();
    } catch (e) {
      setNotice(toApiError(e).code);
    }
  }

  async function adopt(wt: WorktreeView): Promise<void> {
    setNotice(undefined);
    try {
      await api.worktreeAdopt(wt.path);
      await load();
    } catch (e) {
      setNotice(toApiError(e).code);
    }
  }


  // The parent picker and the row menu's lineage and status items write straight through `worktreeDetails`.
  async function setDetails(wt: WorktreeView, patch: DetailsPatch, failure: string): Promise<void> {
    try {
      await api.worktreeDetails(wt.path, patch);
      await load();
    } catch {
      pushToast({ text: failure });
    }
  }

  async function saveDetails(patch: DetailsPatch): Promise<void> {
    if (!editing || editing.busy) return;
    const { worktree } = editing;
    if (Object.keys(patch).length === 0) return setEditing(null);
    setEditing({ worktree, busy: true });
    try {
      await api.worktreeDetails(worktree.path, patch);
      setEditing(null);
      await load();
    } catch (e) {
      setEditing({ worktree, busy: false, error: toApiError(e).code });
    }
  }

  return {
    groupName, setGroupName, editing, setEditing, forgetting, setForgetting, adding, setAdding, addingRemote, setAddingRemote, scanRoot, setScanRoot,
    forgetRepo, addRepo, addRepoFolder, addPaths, addScanned, sidebarCall, changePrefs, saveGroup, addFolder, openFolder, repoCloned, projectCreated, pin, adopt,
    setDetails, saveDetails,
  };
}
