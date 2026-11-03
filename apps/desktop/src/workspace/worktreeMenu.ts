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
}

/** What the project (repo heading) menu acts on. */
export interface ProjectMenuContext {
  path: string;
  apps: OpenInApp[];
  openIn(target: OpenTarget): void;
  copy(text: string): void;
  repoSettings(): void;
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
    ...read,
    // The primary checkout is the repo itself: it can be pinned but never removed.
    ...(wt.primary ? [] : [SEP("sep2"), { id: "delete", labelKey: "workspace.delete", danger: true, run: ctx.onRemove }]),
  ];
}

/** The repo heading's menu (plan U2). */
export function projectMenuItems(ctx: ProjectMenuContext): MenuItem[] {
  return [
    openInItem(ctx.apps, ctx.openIn),
    { id: "copyPath", labelKey: "worktreeMenu.copyPath", run: () => ctx.copy(ctx.path) },
    SEP("sep1"),
    { id: "repoSettings", labelKey: "project.settings", run: ctx.repoSettings },
    SEP("sep2"),
    { id: "remove", labelKey: "project.remove", danger: true, run: ctx.remove },
  ];
}
