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
    expect(first.profiles.map((p) => p.profile.id)).toEqual(["claude", "codex", "gemini"]);
    expect(first.profiles.find((p) => p.profile.id === "gemini")!.installed).toBe(false);
    expect(first.shells.map((s) => s.id)).toEqual(["shell:powershell", "shell:cmd", "shell:wsl:Ubuntu"]);
    const put = await api.profilePut(custom("mine"));
    expect(put.profiles.at(-1)!.profile.id).toBe("mine");
    expect((await api.profiles()).profiles).toHaveLength(4);
    await expect(api.profileRemove("claude")).rejects.toMatchObject({ code: "builtin_profile" });
    expect((await api.profileRemove("mine")).profiles).toHaveLength(3);
    const shells = await api.shellPut({ id: "shell:mysh", name: "mysh", program: "sh", args: [] });
    expect(shells.shells.at(-1)).toMatchObject({ id: "shell:mysh", custom: true });
    expect((await api.shellRemove("shell:mysh")).shells).toHaveLength(3);
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
});
