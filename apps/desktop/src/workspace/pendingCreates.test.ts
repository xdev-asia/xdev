import { describe, expect, it, vi } from "vitest";
import type { WorktreeView } from "@/api";
import { NO_DETAILS } from "./worktreeDetails";
import { PendingCreates, type CreateArgs } from "./pendingCreates";

const view = (name: string): WorktreeView => ({
  path: `/code/wt/${name}`, name, branch: name, head: null, start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS,
});

/** A create call the test settles by hand. */
function deferred() {
  const calls: { args: CreateArgs; resolve(v: WorktreeView): void; reject(e: unknown): void }[] = [];
  const create = vi.fn((repoId: string, name: string, from: string | null) =>
    new Promise<WorktreeView>((resolve, reject) => calls.push({ args: { repoId, name, from }, resolve, reject })));
  const remove = vi.fn(async () => undefined);
  const onCreated = vi.fn();
  const jobs = new PendingCreates({ create, remove, onCreated });
  return { calls, create, remove, onCreated, jobs };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("PendingCreates", () => {
  it("cancel_then_success_removes_new_worktree", async () => {
    const t = deferred();
    const id = t.jobs.start({ repoId: "r", name: "oak", from: null });
    expect(t.jobs.list("r")).toMatchObject([{ id, name: "oak", state: "running" }]);
    t.jobs.cancel(id);
    expect(t.jobs.list("r")).toEqual([]);
    t.calls[0].resolve(view("oak"));
    await settle();
    expect(t.remove).toHaveBeenCalledTimes(1);
    expect(t.remove).toHaveBeenCalledWith("/code/wt/oak", false);
    expect(t.onCreated).not.toHaveBeenCalled();
    expect(t.jobs.list("r")).toEqual([]);
  });

  it("cancel_then_failure_is_silent", async () => {
    const t = deferred();
    const id = t.jobs.start({ repoId: "r", name: "oak", from: null });
    t.jobs.cancel(id);
    t.calls[0].reject({ code: "git", message: "boom" });
    await settle();
    expect(t.jobs.list("r")).toEqual([]);
    expect(t.remove).not.toHaveBeenCalled();
    expect(t.onCreated).not.toHaveBeenCalled();
  });

  it("failure shows retry and dismiss", async () => {
    const t = deferred();
    const heard = vi.fn();
    t.jobs.subscribe(heard);
    const id = t.jobs.start({ repoId: "r", name: "oak", from: "main" });
    t.calls[0].reject({ code: "worktree_dirty", message: "dirty" });
    await settle();
    expect(t.jobs.list("r")).toMatchObject([{ id, state: "failed", error: { code: "worktree_dirty" } }]);

    t.jobs.retry(id);
    expect(t.create).toHaveBeenCalledTimes(2);
    expect(t.calls[1].args).toEqual({ repoId: "r", name: "oak", from: "main" });
    expect(t.jobs.list("r")).toMatchObject([{ id, state: "running" }]);
    expect(t.jobs.list("r")[0].error).toBeUndefined();
    t.calls[1].reject(new Error("again"));
    await settle();
    expect(t.jobs.list("r")[0].state).toBe("failed");

    t.jobs.dismiss(id);
    expect(t.jobs.list("r")).toEqual([]);
    expect(heard).toHaveBeenCalled();
  });

  it("two_creates_keep_their_rows", async () => {
    const t = deferred();
    const a = t.jobs.start({ repoId: "r", name: "a", from: null });
    const b = t.jobs.start({ repoId: "r", name: "b", from: null });
    t.jobs.start({ repoId: "other", name: "c", from: null });
    expect(t.jobs.list("r").map((p) => p.id)).toEqual([a, b]);
    t.calls[1].resolve(view("b"));
    await settle();
    expect(t.jobs.list("r")).toMatchObject([{ id: a, state: "running" }]);
    expect(t.onCreated).toHaveBeenCalledWith(view("b"), { repoId: "r", name: "b", from: null });
    expect(t.jobs.list("other")).toHaveLength(1);
    expect(t.jobs.list()).toHaveLength(2);
  });

  it("a remove that fails after cancel is swallowed, and unsubscribe stops the calls", async () => {
    const t = deferred();
    t.remove.mockRejectedValueOnce({ code: "worktree_dirty" });
    const heard = vi.fn();
    const off = t.jobs.subscribe(heard);
    off();
    const id = t.jobs.start({ repoId: "r", name: "oak", from: null });
    t.jobs.cancel(id);
    t.calls[0].resolve(view("oak"));
    await settle();
    expect(heard).not.toHaveBeenCalled();
    expect(t.remove).toHaveBeenCalledTimes(1);
  });
});
