import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { PtyClient } from "./ptyClient";

const text = (chunks: Uint8Array[]) => new TextDecoder().decode(Uint8Array.from(chunks.flatMap((c) => [...c])));

function held(output = "while you were away\r\n", lost = 0) {
  const api = createMockApi({});
  api.__ptydSet({ state: "running" });
  api.__ptydHold({ id: "p1", output, lost, info: { agent: true, profile: "claude", cli: "claude" } });
  return api;
}

describe("PtyClient.attach", () => {
  it("binds a later start to the attached pty instead of spawning one", async () => {
    const api = held();
    const spawn = vi.spyOn(api, "ptySpawn");
    const client = new PtyClient(api, "p1");
    const attached = await client.attach(0);
    expect(attached).toMatchObject({ seq: 0, truncated: false });
    // Output that arrives before a view is there waits for it.
    await new Promise((r) => setTimeout(r, 5));
    const got: Uint8Array[] = [];
    const info = await client.start("/demo", "claude", 80, 24, (b, rendered) => {
      got.push(b);
      rendered();
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(info).toMatchObject({ id: "p1", agent: true, profile: "claude" });
    expect(text(got)).toBe("while you were away\r\n");
    expect(client.spawned).toBe(true);
    // The tab takes input as a spawned one does.
    await client.input("x");
    expect(text(got)).toContain("x");
    client.dispose();
  });

  it("counts seq from where the attach started", async () => {
    const api = held("0123456789");
    const client = new PtyClient(api, "p1");
    const got: Uint8Array[] = [];
    await client.attach(4, (b, rendered) => {
      got.push(b);
      rendered();
    });
    await vi.waitFor(() => expect(text(got)).toBe("456789"));
    expect(client.seq).toBe(10);
    client.dispose();
  });

  it("counts seq for a spawned pty from 0, by what was drawn", async () => {
    const api = createMockApi({});
    const client = new PtyClient(api, "s1");
    let drawn = 0;
    await client.start("/demo", "shell", 80, 24, (b, rendered) => {
      drawn += b.length;
      rendered();
    });
    expect(client.seq).toBe(drawn);
    expect(drawn).toBeGreaterThan(0);
    client.dispose();
  });

  it("nudges the size so a full-screen program redraws", async () => {
    const api = held();
    const resize = vi.spyOn(api, "ptyResize");
    const client = new PtyClient(api, "p1");
    await client.attach(0);
    await client.start("/demo", "claude", 80, 24, () => {});
    await vi.waitFor(() => expect(resize.mock.calls).toEqual([
      ["p1", 79, 24],
      ["p1", 80, 24],
    ]));
    client.dispose();
  });

  it("writes the truncated line before the replay of a cut ring", async () => {
    const api = held("tail\r\n", 4096);
    const client = new PtyClient(api, "p1");
    const attached = await client.attach(0);
    expect(attached.truncated).toBe(true);
    expect(client.seq).toBe(4096);
    await new Promise((r) => setTimeout(r, 5));
    const got: Uint8Array[] = [];
    await client.start("/demo", "claude", 80, 24, (b) => got.push(b), null, { truncated: "— output truncated —" });
    expect(text(got)).toBe("— output truncated —\r\ntail\r\n");
    client.dispose();
  });

  it("rejects with pty_gone when the service does not hold the id", async () => {
    const api = held();
    const client = new PtyClient(api, "other");
    await expect(client.attach(0)).rejects.toMatchObject({ code: "pty_gone" });
    expect(client.spawned).toBe(false);
  });

  it("acks attached output by the same 256 KB rule", async () => {
    const api = held("y".repeat(600 * 1024));
    const ack = vi.spyOn(api, "ptyAck");
    const client = new PtyClient(api, "p1");
    await client.attach(0, (_b, rendered) => rendered());
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(2));
    expect(ack).toHaveBeenLastCalledWith("p1", 262144);
    client.dispose();
  });
});
