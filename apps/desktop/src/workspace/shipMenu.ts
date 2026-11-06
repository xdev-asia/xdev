import type { ForkSync, ShipView } from "@/api";
import type { ShipAction } from "./ship";

export type MenuId =
  | "commit_push"
  | "commit_sync"
  | "pull"
  | "fast_forward"
  | "sync"
  | "rebase"
  | "fetch"
  | "force"
  | "sync_fork"
  | "push_then_pr";

export type Text = { key: string; params?: Record<string, string | number> };
export type MenuEntry =
  | { separator: true }
  | { separator?: false; id: MenuId; label: Text; tooltip?: Text; disabled: boolean };

export type MenuInput = {
  ship: ShipView | null;
  // What the main button does now.
  action: ShipAction;
  // Files checked in the change list, and whether the commit message has text.
  checked: number;
  hasMessage: boolean;
  busy: boolean;
  // The base is a remote branch (or a local one with an upstream).
  baseRemote: boolean;
  // A pull request is already open for the branch.
  hasPr: boolean;
};

const text = (key: string, params?: Text["params"]): Text => (params ? { key, params } : { key });

/** The More menu, top to bottom: labels, disabled flags and tooltips. Pure. */
export function shipMenu(i: MenuInput): MenuEntry[] {
  const { ship } = i;
  const up = ship?.upstream ?? null;
  const rewritten = up?.rewritten ?? false;
  const behind = up?.behind ?? 0;
  const ahead = up?.ahead ?? 0;
  const attached = ship !== null && ship.branch !== null && ship.remote !== null;
  const comboOff = i.busy || !attached || i.checked === 0 || !i.hasMessage;
  const baseRef = ship?.base ?? "";
  const entries: MenuEntry[] = [];

  entries.push({
    id: "commit_push",
    label: text(rewritten ? "ship.combo.forcePush" : "ship.combo.push"),
    tooltip: text(rewritten ? "ship.combo.forcePush.tip" : behind > 0 ? "ship.combo.push.behindTip" : "ship.combo.push.tip"),
    disabled: comboOff,
  });
  entries.push({
    id: "commit_sync",
    label: text("ship.combo.sync"),
    tooltip: text(rewritten ? "ship.combo.sync.rewrittenTip" : "ship.combo.sync.tip"),
    disabled: comboOff || rewritten,
  });
  entries.push({ separator: true });

  entries.push({ id: "pull", label: text("ship.more.pull"), disabled: i.busy || !attached });
  if (behind > 0 && !rewritten) {
    entries.push({ id: "fast_forward", label: text("ship.update.fastForward", { count: behind }), disabled: i.busy || !attached });
  } else {
    entries.push({
      id: "fast_forward",
      label: text("ship.update.fastForward", { count: behind }),
      tooltip: text(rewritten ? "ship.update.ff.rewrittenTip" : ahead > 0 ? "ship.update.ff.aheadTip" : "ship.update.ff.noneTip"),
      disabled: true,
    });
  }
  entries.push({
    id: "sync",
    label: text("ship.update.sync", { behind, ahead }),
    disabled: i.busy || !attached,
  });
  entries.push({
    id: "rebase",
    label: baseRef ? text("ship.update.rebase", { ref: baseRef }) : text("ship.update.rebaseBase"),
    tooltip: !i.baseRemote
      ? text("ship.update.rebase.noRemoteTip")
      : baseRef
        ? text("ship.update.rebase.tip", { ref: baseRef })
        : undefined,
    disabled: i.busy || !attached || !i.baseRemote,
  });
  entries.push({ id: "fetch", label: text("ship.more.fetch"), disabled: i.busy || !attached });
  entries.push({ id: "force", label: text("ship.more.force"), disabled: i.busy || up === null || up.id === null });
  // Moves origin's default branch, not this one, so it does not need the branch attached.
  if (ship?.hasForkUpstream) entries.push({ id: "sync_fork", label: text("ship.menu.syncFork"), disabled: i.busy });

  if ((i.action === "push" || i.action === "publish") && !i.hasPr) {
    entries.push({ separator: true });
    entries.push({ id: "push_then_pr", label: text(i.ship?.reviewHost === "gitlab" ? "ship.combo.pushThenMr" : "ship.combo.pushThenPr"), disabled: i.busy || !attached });
  }
  return entries;
}

/** What a Sync fork did, in words. Pure. */
export function forkSyncText(result: ForkSync): Text {
  if (result.status === "up_to_date") return text("ship.syncFork.upToDate");
  if (result.status === "synced") return text("ship.syncFork.synced", { count: result.behind });
  const branch = result.branch ?? "";
  switch (result.reason) {
    case "diverged":
      return text("ship.syncFork.diverged", { branch });
    case "missing_origin_branch":
      return text("ship.syncFork.noOriginBranch", { branch });
    case "missing_upstream_default_branch":
      return text("ship.syncFork.noDefault");
    default:
      return text("ship.syncFork.noRemotes");
  }
}
