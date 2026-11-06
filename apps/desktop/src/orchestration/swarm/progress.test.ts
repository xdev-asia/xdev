import { describe, expect, it } from "vitest";
import type { SwarmRow } from "@/api";
import { clampCount, counts, isLive } from "./progress";

const row = (state: SwarmRow["state"]): SwarmRow => ({ dispatch: `d-${state}`, tab: "t", agent: "claude", state, lastLine: "" });

describe("swarm progress", () => {
  it("the count defaults to 4 and is held between 1 and 12", () => {
    expect(clampCount("")).toBe(4);
    expect(clampCount("abc")).toBe(4);
    expect(clampCount("0")).toBe(1);
    expect(clampCount("7")).toBe(7);
    expect(clampCount("12")).toBe(12);
    expect(clampCount("99")).toBe(12);
  });

  it("a worker is live until it has ended", () => {
    expect(["starting", "ready", "stopping", "start_unknown"].every((s) => isLive(row(s as SwarmRow["state"])))).toBe(true);
    expect(["succeeded", "failed", "stopped", "abandoned"].some((s) => isLive(row(s as SwarmRow["state"])))).toBe(false);
    expect(counts([row("ready"), row("stopped"), row("starting")])).toEqual({ live: 2, ended: 1, total: 3 });
  });
});
