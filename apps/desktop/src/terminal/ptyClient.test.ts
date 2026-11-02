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
    await client.start("/demo", "shell", 80, 24, () => {});
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
    await api.ptyApprove("claude");
    await expect(client.start("/demo", "claude", 80, 24, () => {})).resolves.toMatchObject({ agent: true });
    client.dispose();
  });

  it("kills the pty on dispose", async () => {
    const api = createMockApi({});
    const kill = vi.spyOn(api, "ptyKill");
    const client = new PtyClient(api, "t5");
    await client.start("/demo", "shell", 80, 24, () => {});
    client.dispose();
    expect(kill).toHaveBeenCalledWith("t5");
  });
});
