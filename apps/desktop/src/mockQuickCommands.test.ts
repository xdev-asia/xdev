import { describe, expect, it } from "vitest";
import { createMockApi, QUICK_COMMAND_LIMITS } from "./api";
import type { QuickCommand, SettingsSection } from "./api";
import { DEMO_WORKSPACE } from "./mockWorkspace";

const terminal = (label: string, command: string, scope: QuickCommand["scope"] = { type: "global" }): QuickCommand => ({
  id: "", label, scope, action: { type: "terminal", command, appendEnter: true },
});

describe("mock quick commands", () => {
  it("stores trimmed commands with new ids and emits quickCommands", async () => {
    const api = createMockApi({});
    const heard: SettingsSection[][] = [];
    api.onSettingsChanged((e) => heard.push(e.sections));
    const saved = await api.quickCommandUpsert(terminal("  Tests ", "cargo test  \n"));
    expect(saved).toMatchObject({ label: "Tests", action: { command: "cargo test" } });
    expect(saved.id).not.toBe("");
    const renamed = await api.quickCommandUpsert({ ...saved, label: "All tests" });
    expect(renamed.id).toBe(saved.id);
    expect((await api.quickCommandsList()).map((c) => c.label)).toEqual(["All tests"]);
    expect(heard).toEqual([["quickCommands"], ["quickCommands"]]);
  });

  it("rejects bad fields with the field as detail", async () => {
    const api = createMockApi({});
    await expect(api.quickCommandUpsert(terminal(" ", "ls"))).rejects.toEqual({ code: "bad_arg", detail: "label" });
    await expect(api.quickCommandUpsert(terminal("x".repeat(QUICK_COMMAND_LIMITS.label + 1), "ls"))).rejects.toMatchObject({ detail: "label" });
    await expect(api.quickCommandUpsert(terminal("Ls", "  \n"))).rejects.toMatchObject({ detail: "command" });
    await expect(api.quickCommandUpsert(terminal("Ls", "ls", { type: "repo", repo: "/nowhere" }))).rejects.toMatchObject({ detail: "repo" });
    const agent = (profile: string, prompt: string): QuickCommand => ({ id: "", label: "Review", scope: { type: "global" }, action: { type: "agent", profile, prompt } });
    await expect(api.quickCommandUpsert(agent("nobody", "Review"))).rejects.toMatchObject({ detail: "profile" });
    await expect(api.quickCommandUpsert(agent("claude", " "))).rejects.toMatchObject({ detail: "prompt" });
    expect(await api.quickCommandUpsert(agent("claude", "Review"))).toMatchObject({ action: { profile: "claude" } });
    expect(await api.quickCommandsList()).toHaveLength(1);
  });

  it("moves within its own scope only and records recent runs", async () => {
    const api = createMockApi({});
    const repo = (await api.workspaceList())[0].path;
    const a = await api.quickCommandUpsert(terminal("A", "a"));
    const r = await api.quickCommandUpsert(terminal("R", "r", { type: "repo", repo }));
    const b = await api.quickCommandUpsert(terminal("B", "b"));
    await api.quickCommandsMove(b.id, 0);
    expect((await api.quickCommandsList()).map((c) => c.label)).toEqual(["B", "R", "A"]);
    await expect(api.quickCommandsMove("qc-none", 0)).rejects.toMatchObject({ code: "not_found" });
    await api.quickCommandUsed(a.id);
    await api.quickCommandUsed(r.id);
    await api.quickCommandUsed(a.id);
    await api.quickCommandUsed("qc-none");
    expect(await api.quickCommandsRecent()).toEqual([a.id, r.id]);
    await api.quickCommandDelete(a.id);
    await api.quickCommandDelete(a.id);
    expect(await api.quickCommandsRecent()).toEqual([r.id]);
    expect((await api.quickCommandsList()).map((c) => c.label)).toEqual(["B", "R"]);
  });

  it("lists repo file commands and trusts them by hash", async () => {
    const commands = [{ label: "Lint", action: { type: "terminal" as const, command: "pnpm lint", appendEnter: true } }];
    const api = createMockApi({}, { workspace: { ...DEMO_WORKSPACE, repoFiles: { "/demo/xdev": { commands, commandErrors: ["commands[1]: needs run or prompt"] } } } });
    const path = (await api.workspaceList())[0].worktrees[1].path;
    const listed = await api.repoFileCommands(path);
    expect(listed).toMatchObject({ trusted: false, commands, errors: ["commands[1]: needs run or prompt"] });
    await expect(api.repoFileCommandsTrust(path, "stale")).rejects.toMatchObject({ code: "hook_untrusted" });
    expect(await api.repoFileCommandsTrust(path, listed.hash)).toMatchObject({ trusted: true });
    expect(await api.repoFileCommands("/demo/xdev")).toMatchObject({ trusted: true });
    expect(await createMockApi({}).repoFileCommands(path)).toEqual({ trusted: false, hash: "", commands: [], errors: [] });
    await expect(api.repoFileCommands("/nowhere")).rejects.toMatchObject({ code: "worktree_unknown" });
  });
});
