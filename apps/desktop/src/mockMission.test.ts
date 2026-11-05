import { describe, expect, it } from "vitest";
import { createMockMission } from "./mockMission";
import { stuckReason } from "./orchestration/stuck";

describe("mock mission", () => {
  it("has a silent and a waiting worker in the demo team", async () => {
    const m = createMockMission(() => 10_000_000);
    const v = await m.orchestrationMission();
    const stuck = v.tabs.map((t) => [t.id, stuckReason(t, v.nowMs, v.settings.stuckMinutes)]);
    expect(stuck).toContainEqual(["demo-builder", "silent"]);
    expect(stuck).toContainEqual(["demo-review", "waiting"]);
    expect(stuck).toContainEqual(["demo-docs", null]);
  });

  it("links start with both grants off, keep a grant, and reset grants on relink", async () => {
    const m = createMockMission(() => 1);
    const l = await m.orchestrationLinkPut("demo-lead", "demo-review");
    expect([l.transcript, l.screen]).toEqual([false, false]);
    await m.orchestrationLinkGrant("demo-lead", "demo-review", "transcript", true);
    const again = (await m.orchestrationMission()).links.find((x) => x.to === "demo-review");
    expect(again?.transcript).toBe(true);
    const moved = await m.orchestrationLinkRetarget("demo-lead", "demo-review", "demo-docs");
    expect([moved.to, moved.transcript]).toEqual(["demo-docs", false]);
    await expect(m.orchestrationLinkRetarget("demo-lead", "demo-docs", "demo-builder")).rejects.toMatchObject({ code: "orchestration" });
  });

  it("records a nudge with its time and the configured text", async () => {
    const m = createMockMission(() => 42);
    await m.orchestrationMissionSettingsPut({ stuckMinutes: 5, nudgePrompt: " ping " });
    const msg = await m.orchestrationNudge("demo-builder");
    expect(msg.body).toBe("ping");
    expect(m.__nudges()).toEqual([{ tab: "demo-builder", text: "ping", at: 42 }]);
    const tab = (await m.orchestrationMission()).tabs.find((t) => t.id === "demo-builder");
    expect(tab?.lastNudgeMs).toBe(42);
  });

  it("hands off only to a live agent tab and stops only a worker", async () => {
    const m = createMockMission(() => 1);
    await expect(m.orchestrationHandoff("demo-lead", "nope", "x")).rejects.toMatchObject({ code: "orchestration" });
    await m.orchestrationHandoff("demo-lead", "demo-review", " look ");
    expect(m.__handoffs()).toEqual([{ from: "demo-lead", to: "demo-review", text: "look" }]);
    await expect(m.orchestrationTabStop("demo-lead")).rejects.toMatchObject({ code: "orchestration" });
    await m.orchestrationTabStop("demo-docs");
    expect((await m.orchestrationMission()).tabs.some((t) => t.id === "demo-docs")).toBe(false);
  });
});
