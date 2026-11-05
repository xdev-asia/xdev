import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { PtyClient } from "./ptyClient";

describe("PtyClient resume", () => {
  it("hands its resume id to ptySpawn", async () => {
    const api = createMockApi({});
    await api.ptyApprove("claude", null);
    const spawn = vi.spyOn(api, "ptySpawn");
    const client = new PtyClient(api, "r1", "abc-123");
    await client.start("/demo", "claude", 80, 24, () => {});
    expect(spawn.mock.calls[0][7]).toBe("abc-123");
    await client.dispose();
  });

  it("a shell refuses a resume id, as Rust does", async () => {
    const api = createMockApi({});
    const client = new PtyClient(api, "r2", "abc");
    await expect(client.start("/demo", "shell", 80, 24, () => {})).rejects.toMatchObject({ code: "bad_arg" });
  });

  it("a fork needs a session id, as Rust does", async () => {
    const api = createMockApi({});
    await api.ptyApprove("claude", null);
    await expect(
      api.ptySpawn("f1", "/demo", "claude", null, 80, 24, () => {}, undefined, true),
    ).rejects.toMatchObject({ code: "bad_arg" });
    const info = await api.ptySpawn("f2", "/demo", "claude", null, 80, 24, () => {}, "abc", true);
    expect(info.agent).toBe(true);
    await api.ptyKill("f2");
  });
});
