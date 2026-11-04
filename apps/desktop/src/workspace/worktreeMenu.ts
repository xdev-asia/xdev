import type { OpenInApp, OpenTarget, WorktreeView } from "@/api";
import type { MenuItem } from "@/ui/ContextMenu";

/** What the worktree row menu acts on. */
export interface WorktreeMenuContext {
  worktree: WorktreeView;
  /** The Open In apps from settings, in order. */
  apps: OpenInApp[];
  unread: boolean;
  openIn(target: OpenTarget): void;
  copy(text: string): void;
  /** Opens a shell tab in this worktree; without it the item is left out. */
  newTerminal?(): void;
  onPin(): void;
  onMarkUnread?(): void;
  onMarkRead?(): void;
  onRemove(): void;
  /** Opens the details dialog; without it the item is left out. */
  onEditDetails?(): void;
  /** Archives the worktree (folder goes, branch stays); without it the item is left out. */
  onArchive?(): void;
}

/** What the project (repo heading) menu acts on. */
export interface ProjectMenuContext {
  path: string;
  apps: OpenInApp[];
  openIn(target: OpenTarget): void;
  copy(text: string): void;
  repoSettings(): void;
  remove(): void;
  /** "Review N branches", already worded; null when no branch is kept. */
  review?: { label: string; run(): void } | null;
  /** Groups and the one the repo is in; without `moveToGroup` the group items are left out. */
  groups?: { id: string; name: string }[];
  groupId?: string | null;
  moveToGroup?(group: string | null): void;
  newGroup?(): void;
}

/** What the plain folder menu acts on. */
export interface FolderMenuContext {
  path: string;
  copy(text: string): void;
  forget(): void;
  newTerminal?(): void;
  groups?: { id: string; name: string }[];
  groupId?: string | null;
  moveToGroup?(group: string | null): void;
  newGroup?(): void;
}

/** What a group heading's menu acts on. */
export interface GroupMenuContext {
  rename(): void;
  remove(): void;
}

const SEP = (id: string): MenuItem => ({ id, labelKey: "", kind: "separator" });

/** The Open in submenu: each app, a separator, File Manager and, when given, a terminal tab here. */
export function openInItem(apps: OpenInApp[], openIn: (t: OpenTarget) => void, newTerminal?: () => void): MenuItem {
  // An app's label is the user's own text; `t` hands an unknown key back unchanged.
  const appRows: MenuItem[] = apps.map((a) => ({ id: `app:${a.id}`, labelKey: a.label, run: () => openIn({ type: "app", id: a.id }) }));
  const rest: MenuItem[] = [
    { id: "fileManager", labelKey: "openIn.fileManager", run: () => openIn({ type: "fileManager" }) },
    ...(newTerminal ? [{ id: "newTerminal", labelKey: "openIn.newTerminal", run: newTerminal }] : []),
  ];
  return { id: "openIn", labelKey: "openIn.menu", children: appRows.length > 0 ? [...appRows, SEP("openInSep"), ...rest] : rest };
}

/** The worktree row's right-click items (plan U1). */
export function worktreeMenuItems(ctx: WorktreeMenuContext): MenuItem[] {
  const wt = ctx.worktree;
  const read: MenuItem[] =
    ctx.unread && ctx.onMarkRead
      ? [{ id: "markRead", labelKey: "workspace.markRead", run: ctx.onMarkRead }]
      : ctx.onMarkUnread
        ? [{ id: "markUnread", labelKey: "workspace.markUnread", run: ctx.onMarkUnread }]
        : [];
  return [
    openInItem(ctx.apps, ctx.openIn, ctx.newTerminal),
    { id: "copyPath", labelKey: "worktreeMenu.copyPath", run: () => ctx.copy(wt.path) },
    { id: "copyName", labelKey: "worktreeMenu.copyName", run: () => ctx.copy(wt.name) },
    { id: "copyBranch", labelKey: "worktreeMenu.copyBranch", disabled: !wt.branch, run: () => wt.branch && ctx.copy(wt.branch) },
    SEP("sep1"),
    { id: "pin", labelKey: wt.pinned ? "workspace.unpin" : "workspace.pin", run: ctx.onPin },
    ...(ctx.onEditDetails && !wt.primary ? [{ id: "details", labelKey: "workspace.details.menu", run: ctx.onEditDetails }] : []),
    ...read,
    // The primary checkout is the repo itself: it can be pinned but never removed.
    ...(wt.primary
      ? []
      : [
          SEP("sep2"),
          ...(ctx.onArchive ? [{ id: "archive", labelKey: "workspace.archive.menu", run: ctx.onArchive }] : []),
          { id: "delete", labelKey: "workspace.delete", danger: true, run: ctx.onRemove },
        ]),
  ];
}

/** The repo heading's menu (plan U2). */
export function projectMenuItems(ctx: ProjectMenuContext): MenuItem[] {
  return [
    openInItem(ctx.apps, ctx.openIn),
    { id: "copyPath", labelKey: "worktreeMenu.copyPath", run: () => ctx.copy(ctx.path) },
    SEP("sep1"),
    { id: "repoSettings", labelKey: "project.settings", run: ctx.repoSettings },
    // The label is already worded with the count; `t` hands an unknown key back unchanged.
    ...(ctx.review ? [{ id: "review", labelKey: ctx.review.label, run: ctx.review.run }] : []),
    ...groupItems(ctx),
    SEP("sep2"),
    { id: "remove", labelKey: "project.remove", danger: true, run: ctx.remove },
  ];
}

/** "Move to group" with each group and a new one, and "Remove from group" while in one. */
function groupItems(ctx: { groups?: { id: string; name: string }[]; groupId?: string | null; moveToGroup?(group: string | null): void; newGroup?(): void }): MenuItem[] {
  const { moveToGroup } = ctx;
  if (!moveToGroup) return [];
  const pick = (ctx.groups ?? []).map((g): MenuItem => ({ id: `group:${g.id}`, labelKey: g.name, checked: ctx.groupId === g.id, run: () => moveToGroup(g.id) }));
  const make: MenuItem[] = ctx.newGroup ? [{ id: "newGroup", labelKey: "group.new", run: ctx.newGroup }] : [];
  return [
    { id: "moveToGroup", labelKey: "group.move", children: [...pick, ...(pick.length > 0 && make.length > 0 ? [SEP("groupSep")] : []), ...make] },
    ...(ctx.groupId ? [{ id: "ungroup", labelKey: "group.ungroup", run: () => moveToGroup(null) }] : []),
  ];
}

/** The plain folder row's menu: a terminal tab, copy path, groups, and forget (nothing on disk is touched). */
export function folderMenuItems(ctx: FolderMenuContext): MenuItem[] {
  return [
    ...(ctx.newTerminal ? [{ id: "newTerminal", labelKey: "openIn.newTerminal", run: ctx.newTerminal }] : []),
    { id: "copyPath", labelKey: "worktreeMenu.copyPath", run: () => ctx.copy(ctx.path) },
    ...groupItems(ctx),
    SEP("sep1"),
    { id: "forget", labelKey: "folder.forget", danger: true, run: ctx.forget },
  ];
}

/** The group heading's menu. Removing a group moves its members to the top level. */
export function groupMenuItems(ctx: GroupMenuContext): MenuItem[] {
  return [
    { id: "rename", labelKey: "group.rename", run: ctx.rename },
    SEP("sep1"),
    { id: "remove", labelKey: "group.remove", danger: true, run: ctx.remove },
  ];
}
