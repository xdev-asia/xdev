import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { AGENT_START_MS, pastePrompt } from "@/workspace/agentPrompt";
import { PtyClient, toBytes } from "./ptyClient";

const text = (chunks: Uint8Array[]) => new TextDecoder().decode(Uint8Array.from(chunks.flatMap((c) => [...c])));

describe("PtyClient", () => {
  it("toBytes accepts ArrayBuffer, Uint8Array and number[]", () => {
    expect([...toBytes(new Uint8Array([1, 2]).buffer)]).toEqual([1, 2]);
    expect([...toBytes(new Uint8Array([4]))]).toEqual([4]);
    expect([...toBytes([3])]).toEqual([3]);
  });

  it("echoes input through the mock pty", async () => {
    const api = createMockApi({});
    const client = new PtyClient(api, "t1");
    const got: Uint8Array[] = [];
    await client.start("/demo", "shell", 80, 24, (b) => got.push(b));
    await client.input("hi");
    expect(text(got)).toContain("hi");
    client.dispose();
  });

  it("typeWhenReady waits for the pty to start, then types; after the start it types at once", async () => {
    const api = createMockApi({});
    const write = vi.spyOn(api, "ptyWrite");
    const client = new PtyClient(api, "t0");
    client.typeWhenReady("first\r");
    expect(write).not.toHaveBeenCalled();
    await client.start("/demo", "shell", 80, 24, () => {});
    expect(write).toHaveBeenCalledTimes(1);
    client.typeWhenReady("second\r");
    expect(write).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("typeWhenReady on a disposed client never types", async () => {
    const api = createMockApi({});
    const write = vi.spyOn(api, "ptyWrite");
    const client = new PtyClient(api, "t0b");
    client.typeWhenReady("x");
    await client.dispose();
    expect(write).not.toHaveBeenCalled();
  });

  it("acks once per 256 KB handed to the terminal", async () => {
    const api = createMockApi({});
    const ack = vi.spyOn(api, "ptyAck");
    const client = new PtyClient(api, "t2");
    await client.start("/demo", "shell", 80, 24, (_b, rendered) => rendered());
    await client.input("x".repeat(600 * 1024));
    expect(ack.mock.calls).toEqual([
      ["t2", 262144],
      ["t2", 262144],
    ]);
    client.dispose();
  });

  it("drops a resize to the same size", async () => {
    const api = createMockApi({});
    const resize = vi.spyOn(api, "ptyResize");
    const client = new PtyClient(api, "t3");
    await client.start("/demo", "shell", 80, 24, () => {});
    await client.resize(100, 30);
    await client.resize(100, 30);
    expect(resize).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("a forced resize sends the same size again (after Reset Terminal)", async () => {
    const api = createMockApi({});
    const resize = vi.spyOn(api, "ptyResize");
    const client = new PtyClient(api, "t3b");
    await client.start("/demo", "shell", 80, 24, () => {});
    await client.resize(100, 30);
    await client.resize(100, 30, true);
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenLastCalledWith("t3b", 100, 30);
    client.dispose();
  });

  it("claude asks for approval first", async () => {
    const api = createMockApi({});
    const client = new PtyClient(api, "t4");
    await expect(client.start("/demo", "claude", 80, 24, () => {})).rejects.toMatchObject({ code: "needs_approval" });
    await api.ptyApprove("claude", null);
    await expect(client.start("/demo", "claude", 80, 24, () => {})).resolves.toMatchObject({ agent: true });
    client.dispose();
  });

  it("kills the pty on dispose", async () => {
    const api = createMockApi({});
    const kill = vi.spyOn(api, "ptyKill");
    const client = new PtyClient(api, "t5");
    await client.start("/demo", "shell", 80, 24, () => {});
    await client.dispose();
    expect(kill).toHaveBeenCalledWith("t5");
  });

  it("acks only what the terminal has rendered", async () => {
    const api = createMockApi({});
    const ack = vi.spyOn(api, "ptyAck");
    const client = new PtyClient(api, "t6");
    const pending: (() => void)[] = [];
    await client.start("/demo", "shell", 80, 24, (_b, rendered) => pending.push(rendered));
    await client.input("x".repeat(600 * 1024));
    expect(ack).not.toHaveBeenCalled();
    pending.forEach((rendered) => rendered());
    expect(ack).toHaveBeenCalledTimes(2);
    await client.dispose();
  });

  it("a stop during spawn kills the pty once the spawn is done", async () => {
    const api = createMockApi({});
    let finish: () => void = () => {};
    const spawn = api.ptySpawn.bind(api);
    vi.spyOn(api, "ptySpawn").mockImplementation((...args) => new Promise((ok) => { finish = () => ok(spawn(...args)); }));
    const kill = vi.spyOn(api, "ptyKill");
    const client = new PtyClient(api, "t7");
    const started = client.start("/demo", "shell", 80, 24, () => {});
    await Promise.resolve();
    const stopped = client.dispose();
    expect(kill).not.toHaveBeenCalled();
    finish();
    await started;
    await stopped;
    expect(kill).toHaveBeenCalledWith("t7");
  });

  it("passes fork: true with the resume id, and nothing for a plain start", async () => {
    const api = createMockApi({});
    await api.ptyApprove("claude", null, "src-1", true);
    const spawn = vi.spyOn(api, "ptySpawn");
    await new PtyClient(api, "f1", "src-1", true).start("/demo", "claude", 80, 24, () => {});
    expect(spawn.mock.calls[0].slice(7, 9)).toEqual(["src-1", true]);
    await new PtyClient(api, "f2").start("/demo", "shell", 80, 24, () => {});
    expect(spawn.mock.calls[1].slice(7)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("an argv agent gets its prompt in the spawn and nothing is typed", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockApi({});
      await api.ptyApprove("claude", null);
      const spawn = vi.spyOn(api, "ptySpawn");
      const write = vi.spyOn(api, "ptyWrite");
      const client = new PtyClient(api, "p1", undefined, undefined, "fix it");
      await client.start("/demo", "claude", 80, 24, () => {});
      expect(spawn.mock.calls[0][9]).toBe("fix it");
      await vi.advanceTimersByTimeAsync(AGENT_START_MS + 2_000);
      expect(write).not.toHaveBeenCalled();
      // A restart of the client never sends it again.
      await api.ptyKill("p1");
      await client.start("/demo", "claude", 80, 24, () => {});
      expect(spawn.mock.calls[1][9]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a spawn refused for approval keeps the prompt for the retry", async () => {
    const api = createMockApi({});
    const spawn = vi.spyOn(api, "ptySpawn");
    const client = new PtyClient(api, "p3", undefined, undefined, "fix it");
    await expect(client.start("/demo", "claude", 80, 24, () => {})).rejects.toMatchObject({ code: "needs_approval" });
    expect(spawn.mock.calls[0][9]).toBe("fix it");
    await api.ptyApprove("claude", null);
    await client.start("/demo", "claude", 80, 24, () => {});
    expect(spawn.mock.calls[1][9]).toBe("fix it");
    client.dispose();
  });

  it("an after-start agent is typed the prompt after its first output and 1500 ms quiet", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockApi({});
      let emit: (bytes: Uint8Array) => void = () => {};
      vi.spyOn(api, "ptySpawn").mockImplementation(async (id, _cwd, profile, _account, _cols, _rows, onData) => {
        emit = onData;
        return { id, pid: 1, program: "amp", agent: true, profile, permissions: "ask", account: null, accountSource: null, hooks: false, hookEvents: [], cli: null, promptAfter: "fix it" };
      });
      const write = vi.spyOn(api, "ptyWrite").mockResolvedValue();
      const client = new PtyClient(api, "p2", undefined, undefined, "fix it");
      await client.start("/demo", "amp", 80, 24, () => {});
      await vi.advanceTimersByTimeAsync(5_000);
      expect(write).not.toHaveBeenCalled();
      emit(new Uint8Array([65]));
      await vi.advanceTimersByTimeAsync(1_000);
      emit(new Uint8Array([66]));
      await vi.advanceTimersByTimeAsync(1_400);
      expect(write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(write).toHaveBeenCalledOnce();
      expect(new TextDecoder().decode(write.mock.calls[0][1])).toBe(pastePrompt("fix it"));
      emit(new Uint8Array([67]));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(write).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a client disposed in the same tick never spawns", async () => {
    const api = createMockApi({});
    const spawn = vi.spyOn(api, "ptySpawn");
    const client = new PtyClient(api, "t8");
    const started = client.start("/demo", "shell", 80, 24, () => {});
    await client.dispose();
    await expect(started).rejects.toThrow("disposed");
    expect(spawn).not.toHaveBeenCalled();
  });
});
