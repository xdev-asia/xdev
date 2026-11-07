import { useRef, useState } from "react";
import { toApiError, type Api, type ApiError, type KeptBranch, type SidebarItem, type WorktreeView } from "@/api";
import type { useI18n } from "@/i18n";
import { getNavigationSettings, setNavigationSettings } from "@/settings/navigationSettings";
import { keptOutcome, removeArgs } from "@/workspace/deleteFlow";
import { clear as clearPicked, runBulk, type Selection } from "@/workspace/selection";
import type { Sessions } from "@/workspace/sessions";
import type { BulkState, Removing, Review, View } from "@/workspace/shellModel";
import { keptByRepo } from "@/workspace/sidebarModel";
import { pushToast } from "@/workspace/toastStore";

type T = ReturnType<typeof useI18n>["t"];

/** Deleting and archiving worktrees, one or many, and the review of the branches they kept. */
export function useShellRemove(o: {
  api: Api;
  t: T;
  sessions: Sessions | null;
  all: WorktreeView[];
  current: WorktreeView | null;
  items: SidebarItem[] | null;
  picked: Selection;
  setPicked(next: Selection): void;
  view: View;
  dialogOpen(): boolean;
  askBeforeDeleteWorktree: boolean;
  alwaysForceDeleteWorktrees: boolean;
  alwaysDeleteKeptBranches: boolean;
  load(): Promise<unknown>;
  setNotice(code: ApiError["code"] | undefined): void;
  openSettings(section: string): void;
  sidebarCall(run: () => Promise<unknown>): Promise<boolean>;
  askArchiveTrust(path: string): Promise<void>;
}) {
  const {
    api, t, sessions, all, current, items, picked, setPicked, view, askBeforeDeleteWorktree, alwaysForceDeleteWorktrees,
    alwaysDeleteKeptBranches, load, setNotice, openSettings, sidebarCall, askArchiveTrust,
  } = o;
  const [bulk, setBulk] = useState<BulkState | null>(null);
  const [review, setReview] = useState<Review | null>(null);

  // Which remove is current; a Cancel during the archive run bumps it so the late result is dropped.
  const removeRun = useRef(0);
  const [removing, setRemoving] = useState<Removing | null>(null);

  function keptNotice(kept: KeptBranch[]): void {
    const out = keptOutcome(kept);
    if (!out) return;
    if (out.kind === "one") {
      const { repoId, branch } = out.kept;
      return void pushToast({
        text: t("review.keptOne.title"),
        actions: [{ label: t("review.keptOne.delete"), run: () => void api.branchDelete(repoId, branch, true).then(() => load(), (e) => setNotice(toApiError(e).code)) }],
      });
    }
    pushToast({ text: t("review.notice", { count: out.count }), actions: [{ label: t("review.notice.button"), run: () => setReview({ repoId: null, busy: false }) }] });
  }

  // "Don't ask again" on the delete dialog: the choice is saved in Settings → General.
  function skipDeleteConfirm(): void {
    void api
      .navigationSettingsPut({ ...getNavigationSettings(), askBeforeDeleteWorktree: false })
      .then((stored) => {
        setNavigationSettings(stored);
        pushToast({ text: t("workspace.remove.skipToast"), actions: [{ label: t("workspace.remove.openSettings"), run: () => openSettings("general") }] });
      })
      .catch((e) => setNotice(toApiError(e).code));
  }

  async function openBulk(mode: "delete" | "archive"): Promise<void> {
    const wts = all.filter((w) => picked.paths.has(w.path) && !w.primary);
    if (wts.length === 0) return;
    const dirty: Record<string, boolean> = {};
    await Promise.all(wts.map(async (w) => void (dirty[w.path] = ((await api.worktreeChanges(w.path).catch(() => [])) as unknown[]).length > 0)));
    setBulk({ mode, worktrees: wts, dirty, busy: false });
  }

  async function confirmBulk(opts: { anyway: boolean; nested: boolean }): Promise<void> {
    if (!bulk || bulk.busy) return;
    const b = bulk;
    setBulk({ ...b, busy: true });
    const chosen = b.worktrees.map((w) => w.path);
    // Nested children go first, so a parent never leaves them half-linked.
    const kids = opts.nested ? all.filter((c) => c.parent && chosen.includes(c.parent) && !chosen.includes(c.path)).map((c) => c.path) : [];
    const list = [...kids, ...chosen];
    const targets = opts.anyway ? list : list.filter((p) => b.dirty[p] !== true);
    const skipped = list.filter((p) => !targets.includes(p));
    const bulkArgs = removeArgs(opts.anyway, { alwaysForce: alwaysForceDeleteWorktrees, alwaysDeleteKept: alwaysDeleteKeptBranches });
    const op = (p: string) => (b.mode === "archive" ? api.worktreeArchive(p, opts.anyway, true) : api.worktreeRemove(p, bulkArgs.force, true, bulkArgs.deleteUnmerged));
    const result = await runBulk(targets, op, async (p) => void (await sessions?.closeWorktree(p)));
    for (const path of skipped) result.failed.push({ path, error: { code: "worktree_dirty" } });
    for (const path of result.ok) sessions?.dropCarried(path);
    setBulk({ ...b, busy: false, result });
    setPicked(clearPicked());
    keptNotice(result.kept);
    await load();
  }

  async function bulkEach(run: (path: string) => Promise<unknown>): Promise<void> {
    setNotice(undefined);
    try {
      for (const path of picked.paths) await run(path);
    } catch (e) {
      setNotice(toApiError(e).code);
    }
    await load();
  }

  function deleteKey(): void {
    if (o.dialogOpen() || view !== "workspace") return;
    const chosen = [...picked.paths];
    if (chosen.length >= 2) return void openBulk("delete");
    const wt = chosen.length === 1 ? all.find((w) => w.path === chosen[0]) : current;
    if (wt && !wt.primary) startRemove(wt);
  }

  // Delete of one worktree (row menu or the delete shortcut). With Settings → General → "Ask before
  // deleting a worktree" off it runs at once with the dialog's defaults (keep the branch, no force,
  // nested worktrees kept); the dialog still shows when the worktree is dirty, the archive script
  // fails or needs trust, or the removal errors. Bulk delete keeps its own dialog.
  function startRemove(wt: WorktreeView, opts: { nested?: boolean } = {}): void {
    const next: Removing = { worktree: wt, dirty: false, busy: false, nested: opts.nested };
    if (askBeforeDeleteWorktree || opts.nested) return setRemoving(next);
    const quiet: Removing = { ...next, quiet: true };
    setRemoving(quiet);
    void remove(false, false, quiet);
  }

  const reviewKept = review ? Object.entries(keptByRepo(items ?? [])).flatMap(([id, list]) => (review.repoId === null || review.repoId === id ? list : [])) : [];

  async function reviewDo(run: () => Promise<unknown>): Promise<void> {
    setReview((r) => (r ? { ...r, busy: true, error: undefined } : r));
    try {
      await run();
      await load();
      setReview((r) => (r ? { ...r, busy: false } : r));
    } catch (e) {
      setReview((r) => (r ? { ...r, busy: false, error: toApiError(e).code } : r));
    }
  }

  async function archiveRemoving(): Promise<void> {
    if (!removing || removing.busy) return;
    const { worktree, dirty } = removing;
    setRemoving({ worktree, dirty, busy: true });
    try {
      await sessions?.closeWorktree(worktree.path);
      sessions?.dropCarried(worktree.path);
      await api.worktreeArchive(worktree.path, dirty, true);
      setRemoving(null);
      await load();
    } catch (e) {
      const code = toApiError(e).code;
      setRemoving({ worktree, dirty: dirty || code === "worktree_dirty", busy: false, error: code === "worktree_dirty" ? undefined : code });
    }
  }

  async function archive(wt: WorktreeView): Promise<void> {
    await sessions?.closeWorktree(wt.path);
    const ok = await sidebarCall(() => api.worktreeArchive(wt.path, false, true));
    if (ok) sessions?.dropCarried(wt.path);
  }

  // Terminals go first so nothing holds the folder, then the folder; uncommitted work needs a
  // second, forced confirm.
  // The archive script runs first (up to 120 s, Cancel stays usable); a failure asks, an untrusted
  // shared script opens the trust prompt, and no script goes straight on.
  async function remove(skipArchive = false, nested = false, target: Removing | null = removing): Promise<void> {
    if (!target || target.busy) return;
    const { worktree, dirty, quiet } = target;
    const run = ++removeRun.current;
    try {
      if (!skipArchive) {
        setRemoving({ worktree, dirty, busy: true, archiving: true, quiet });
        const ran = await api.worktreeArchiveRun(worktree.path);
        if (run !== removeRun.current) return;
        if (ran.ran && ran.code !== 0) return setRemoving({ worktree, dirty, busy: false, failed: { code: ran.code, output: ran.output } });
      }
      setRemoving({ worktree, dirty, busy: true, quiet });
      await sessions?.closeWorktree(worktree.path);
      sessions?.dropCarried(worktree.path);
      if (nested) {
        for (const child of all.filter((c) => c.parent === worktree.path)) {
          await sessions?.closeWorktree(child.path);
          sessions?.dropCarried(child.path);
          await api.worktreeRemove(child.path, alwaysForceDeleteWorktrees, true, alwaysDeleteKeptBranches);
        }
      }
      const args = removeArgs(dirty, { alwaysForce: alwaysForceDeleteWorktrees, alwaysDeleteKept: alwaysDeleteKeptBranches });
      const done = await api.worktreeRemove(worktree.path, args.force, true, args.deleteUnmerged);
      keptNotice(done.kept ? [done.kept] : []);
      setRemoving(null);
      await load();
    } catch (e) {
      if (run !== removeRun.current) return;
      const code = toApiError(e).code;
      if (code === "hook_untrusted") {
        setRemoving({ worktree, dirty, busy: false });
        return void askArchiveTrust(worktree.path);
      }
      const nowDirty = dirty || code === "worktree_dirty";
      setRemoving({ worktree, dirty: nowDirty, busy: false, error: code === "worktree_dirty" ? undefined : code });
    }
  }

  return {
    bulk, setBulk, review, setReview, removing, setRemoving, removeRun, keptNotice, skipDeleteConfirm, openBulk, confirmBulk,
    bulkEach, deleteKey, startRemove, reviewKept, reviewDo, archiveRemoving, archive, remove,
  };
}
