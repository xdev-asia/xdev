import { expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { PtyClient } from "./ptyClient";

const overrides = { model: "opus", effort: "high", extraArgs: ["--verbose"] };

it("a client given launch overrides sends them with the spawn", async () => {
  const api = createMockApi({});
  const spawn = vi.spyOn(api, "ptySpawn");
  await api.ptyApprove("claude", null, undefined, undefined, undefined, overrides);
  const client = new PtyClient(api, "ov1", undefined, false, undefined, undefined, overrides);
  await client.start("/demo", "claude", 80, 24, () => {});
  expect(spawn.mock.calls[0]![10]).toBeUndefined();
  expect(spawn.mock.calls[0]![11]).toEqual(overrides);
  client.dispose();
});

it("a plain client sends none", async () => {
  const api = createMockApi({});
  const spawn = vi.spyOn(api, "ptySpawn");
  const client = new PtyClient(api, "ov2");
  await client.start("/demo", "shell", 80, 24, () => {});
  expect(spawn.mock.calls[0]![11]).toBeUndefined();
  client.dispose();
});
