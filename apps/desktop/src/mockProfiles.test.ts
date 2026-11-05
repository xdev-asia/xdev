import { describe, expect, it } from "vitest";
import { createMockApi } from "./api";

const custom = (id: string) => ({
  id, name: id, cli: null, program: "x", args: [], env: [], model: null,
  effort: null, permissions: null, account: null, startup: [], enabled: true,
});

describe("mock profiles", () => {
  it("mock_profile_put_round_trips", async () => {
    const api = createMockApi({});
    const first = await api.profiles();
    expect(first.profiles.map((p) => p.profile.id)).toHaveLength(13);
    expect(first.profiles.find((p) => p.profile.id === "gemini")!.installed).toBe(false);
    expect(first.shells.map((s) => s.id)).toEqual(["shell:powershell", "shell:cmd", "shell:wsl:Ubuntu"]);
    const put = await api.profilePut(custom("mine"));
    expect(put.profiles.at(-1)!.profile.id).toBe("mine");
    expect((await api.profiles()).profiles).toHaveLength(14);
    await expect(api.profileRemove("claude")).rejects.toMatchObject({ code: "builtin_profile" });
    expect((await api.profileRemove("mine")).profiles).toHaveLength(13);
    const shells = await api.shellPut({ id: "mysh", name: "mysh", program: "sh", args: [] });
    expect(shells.shells.at(-1)).toMatchObject({ id: "shell:mysh", custom: true });
    expect((await api.shellRemove("mysh")).shells).toHaveLength(3);
    const d = await api.profilesDefaults("skip", "codex", "shell:cmd");
    expect(d).toMatchObject({ approvals: "skip", defaultAgent: "codex", defaultShell: "shell:cmd" });
    expect(d.profiles[0].permissions).toBe("skip");
  });

  it("mock_skip_needs_approval_each_time", async () => {
    const api = createMockApi({});
    await api.profilesDefaults("skip", "claude", null);
    const spawn = () => api.ptySpawn(crypto.randomUUID(), "/demo", "claude", null, 80, 24, () => {});
    await expect(spawn()).rejects.toMatchObject({ code: "needs_approval" });
    await api.ptyApprove("claude", null);
    await expect(spawn()).resolves.toMatchObject({ permissions: "skip" });
    await expect(spawn()).rejects.toMatchObject({ code: "needs_approval" });
  });

  it("mock_shell_ids_are_unprefixed", async () => {
    const api = createMockApi({});
    const shell = (id: string) => ({ id, name: "n", program: "sh", args: [] });
    await expect(api.shellPut(shell("shell:mysh"))).rejects.toMatchObject({ code: "invalid_profile" });
    for (const id of ["powershell", "cmd", "login", "Bad Id"]) {
      await expect(api.shellPut(shell(id))).rejects.toMatchObject({ code: "invalid_profile" });
    }
    await api.shellPut(shell("mysh"));
    await expect(api.shellRemove("shell:mysh")).rejects.toMatchObject({ code: "unknown_profile" });
    await expect(api.shellRemove("cmd")).rejects.toMatchObject({ code: "unknown_profile" });
    await expect(api.shellRemove("nope")).rejects.toMatchObject({ code: "unknown_profile" });
    const view = await api.profilesDefaults("ask", "claude", "shell:mysh");
    expect(view.defaultShell).toBe("shell:mysh");
    expect((await api.shellRemove("mysh")).defaultShell).toBe("shell:powershell");
  });

  it("mock_custom_profile_always_asks", async () => {
    const api = createMockApi({});
    await api.profilesDefaults("skip", "claude", null);
    const view = await api.profilePut(custom("mine"));
    expect(view.profiles.find((p) => p.profile.id === "mine")).toMatchObject({ permissions: "ask", followsApprovals: false, builtin: false });
    const claude = view.profiles.find((p) => p.profile.id === "claude")!;
    expect(claude).toMatchObject({ permissions: "skip", followsApprovals: true });
    const withArgs = await api.profilePut({ ...claude.profile, args: ["--x"] });
    expect(withArgs.profiles[0]).toMatchObject({ permissions: "ask", followsApprovals: false });
  });

  it("mock_profile_put_validates_like_rust", async () => {
    const api = createMockApi({});
    const claude = (await api.profiles()).profiles[0].profile;
    const view = await api.profilePut({ ...claude, cli: null, program: "x" });
    expect(view.profiles[0]).toMatchObject({ builtin: true, profile: { cli: "claude" } });
    await expect(api.profilePut({ ...claude, effort: "bogus" })).rejects.toMatchObject({ code: "invalid_profile" });
    await expect(api.profilePut({ ...custom("mine"), effort: "high" })).rejects.toMatchObject({ code: "invalid_profile" });
    await expect(api.profilePut({ ...custom("mine"), cli: "codex" })).rejects.toMatchObject({ code: "invalid_profile" });
    await expect(api.profilePut({ ...custom("mine"), program: null })).rejects.toMatchObject({ code: "invalid_profile" });
    for (const name of ["", "A=B", "A\0"]) {
      await expect(api.profilePut({ ...custom("mine"), env: [{ name, value: "1" }] })).rejects.toMatchObject({ code: "invalid_profile" });
    }
    await expect(api.profilePut({ ...custom("mine"), env: [{ name: "A", value: "a\0" }] })).rejects.toMatchObject({ code: "invalid_profile" });
    expect((await api.profilePut({ ...claude, effort: "high" })).profiles[0].profile.effort).toBe("high");
  });

  it("mock_profile_reset_keeps_what_rust_keeps", async () => {
    const api = createMockApi({});
    const claude = (await api.profiles()).profiles[0].profile;
    await api.profilePut({
      ...claude, args: ["--x"], env: [{ name: "A", value: "1" }], model: "opus", effort: "high",
      account: "work", startup: ["cd src"], permissions: "skip",
    });
    const reset = (await api.profileReset("claude")).profiles[0];
    expect(reset.profile).toMatchObject({ args: [], env: [], permissions: null, model: "opus", effort: "high", account: "work", startup: ["cd src"] });
    const mine = { ...custom("mine"), args: ["--y"], permissions: "accept-edits" as const };
    await api.profilePut(mine);
    const after = await api.profileReset("mine");
    expect(after.profiles.find((p) => p.profile.id === "mine")!.profile).toEqual(mine);
    await expect(api.profileReset("nope")).rejects.toMatchObject({ code: "unknown_profile" });
  });

  it("mock_defaults_match_rust", async () => {
    const api = createMockApi({});
    await expect(api.profilesDefaults("ask", "nope", null)).rejects.toMatchObject({ code: "unknown_profile" });
    const claude = (await api.profiles()).profiles[0].profile;
    // Rust does not check that the default agent is enabled or that the shell exists.
    await api.profilePut({ ...claude, id: "codex", name: "Codex", cli: "codex", enabled: false });
    const view = await api.profilesDefaults("ask", "codex", "shell:ghost");
    expect(view.defaultAgent).toBe("codex");
    expect(view.defaultShell).toBe("shell:powershell");
  });

  it("mock_pty_refuses_missing_and_disabled_profiles", async () => {
    const api = createMockApi({});
    const spawn = (id: string) => api.ptySpawn(crypto.randomUUID(), "/demo", id, null, 80, 24, () => {});
    await expect(spawn("gemini")).rejects.toMatchObject({ code: "not_installed" });
    const codex = (await api.profiles()).profiles[1].profile;
    await api.profilePut({ ...codex, enabled: false });
    await expect(spawn("codex")).rejects.toMatchObject({ code: "profile_off" });
    await expect(spawn("nope")).rejects.toMatchObject({ code: "unknown_profile" });
  });

  it("a_fresh_default_is_auto_and_resolves_to_the_first_installed_agent", async () => {
    const view = await createMockApi({}).profiles();
    expect(view.defaultAgent).toBe("auto");
    expect(view.resolvedDefault).toBe("claude");
  });

  it("refresh_reads_the_installed_list_and_auto_follows_it", async () => {
    const api = createMockApi({});
    api.__installed = ["codex", "devin"];
    const view = await api.agentsRefresh();
    expect(view.profiles.filter((p) => p.installed && p.builtin).map((p) => p.profile.id)).toEqual(["codex", "devin"]);
    expect(view.resolvedDefault).toBe("codex");
    api.__installed = [];
    expect((await api.agentsRefresh()).resolvedDefault).toBeNull();
  });

  it("a_blank_default_resolves_to_no_agent", async () => {
    const api = createMockApi({});
    expect((await api.profilesDefaults("ask", "blank", null)).resolvedDefault).toBeNull();
  });
});
