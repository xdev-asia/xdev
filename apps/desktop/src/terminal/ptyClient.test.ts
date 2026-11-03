import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "../mockApi";
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
