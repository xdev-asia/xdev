import { describe, expect, it } from "vitest";
import { createMockApi } from "./api";
import { DEMO_POLICY_PATH } from "./mockTasks";

describe("mock tasks", () => {
  it("lists the demo tasks newest first with the vault repo as default", async () => {
    const api = createMockApi({});
    const ctx = await api.tasksContext();
    expect(ctx.policyPath).toBe(DEMO_POLICY_PATH);
    expect(ctx.defaultRepo).not.toBeNull();
    const ids = (await api.tasks()).map((t) => t.id);
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it("has no default repo and no demo tasks without a repo", async () => {
    const api = createMockApi({}, { repo: false });
    expect((await api.tasksContext()).defaultRepo).toBeNull();
    expect(await api.tasks()).toEqual([]);
  });

  it("runs a new task to review, then merges it", async () => {
    const api = createMockApi({});
    const { defaultRepo } = await api.tasksContext();
    await expect(api.newTask(defaultRepo!, "  ")).rejects.toEqual({ code: "empty_goal" });
    const task = await api.newTask(defaultRepo!, "Add a retry");
    expect(task.state).toBe("ready");

    await expect(api.runTask(task.id, null, "pnpm test")).rejects.toEqual({
      code: "needs_approval",
      detail: "command requires approval: pnpm",
    });
    await expect(api.runTask(task.id, "nobody", null)).rejects.toEqual({ code: "not_found" });
    await expect(api.approveTask(task.id)).rejects.toMatchObject({ code: "bad_state" });

    const ran = await api.runTask(task.id, null, null);
    expect(ran.state).toBe("review");
    expect(ran.runs).toHaveLength(1);
    expect(ran.runs[0].ended).not.toBeNull();
    expect(ran.evidence?.files.map((f) => f.path)).toEqual(["src/retry.ts"]);
    expect((await api.task(task.id)).state).toBe("review");
    await expect(api.resumeTask(task.id, null)).rejects.toMatchObject({ code: "bad_state" });

    const diff = await api.taskFileDiff(task.id, "src/retry.ts");
    expect(diff.old).not.toBeNull();
    expect(diff.new).not.toBeNull();
    await expect(api.taskFileDiff(task.id, "src/other.ts")).rejects.toEqual({ code: "not_found" });

    const merged = await api.approveTask(task.id);
    expect(merged.state).toBe("merged");
    expect(merged.approval?.merge_commit).toBeTruthy();
    await expect(api.discardTask(task.id)).rejects.toMatchObject({ code: "bad_state" });
  });

  it("serves file diffs from the evidence and refuses binaries", async () => {
    const api = createMockApi({});
    const review = (await api.tasks()).find((t) => t.state === "review")!;
    expect((await api.taskFileDiff(review.id, "src/retry.test.ts")).old).toBeNull();
    await expect(api.taskFileDiff(review.id, "assets/logo.png")).rejects.toEqual({ code: "binary" });
    const failed = (await api.tasks()).find((t) => t.state === "failed")!;
    await expect(api.taskFileDiff(failed.id, "src/retry.ts")).rejects.toMatchObject({ code: "bad_state" });
  });

  it("resumes a failed task with its session and discards it", async () => {
    const api = createMockApi({});
    const failed = (await api.tasks()).find((t) => t.state === "failed")!;
    const resumed = await api.resumeTask(failed.id, null);
    expect(resumed.state).toBe("review");
    expect(resumed.runs.at(-1)?.session_id).toBe("demo-session-2");
    expect((await api.discardTask(failed.id)).state).toBe("discarded");
    await expect(api.discardTask(failed.id)).rejects.toMatchObject({ code: "bad_state" });

    const fresh = await api.newTask((await api.tasksContext()).defaultRepo!, "Nothing yet");
    await expect(api.resumeTask(fresh.id, null)).rejects.toMatchObject({ code: "bad_state" });
  });
});
