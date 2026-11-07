import { describe, expect, it } from "vitest";
import type { Quota } from "@/api";
import { roomiest } from "./StatusBar";

function account(name: string, state: Quota["state"], ...use: (number | null)[]): Quota {
  const keys = ["five_hour", "seven_day"];
  return { name, state, reason: null, windows: use.map((utilization, i) => ({ key: keys[i], utilization, resetsAt: null })), asOf: null };
}

describe("roomiest", () => {
  it("picks the ok account with the lowest highest window", () => {
    const quota = [account("a", "ok", 10, 80), account("b", "ok", 50, 40), account("c", "reserve", 1), account("d", "full", 0), account("e", "unknown")];
    expect(roomiest(quota)?.name).toBe("b");
  });

  it("counts an account without numbers as 0 and keeps list order on ties", () => {
    expect(roomiest([account("a", "ok", 5), account("b", "ok", null), account("c", "ok")])?.name).toBe("b");
    expect(roomiest([account("a", "ok", 5), account("b", "ok", 5)])?.name).toBe("a");
  });

  it("returns null when no account is ok", () => {
    expect(roomiest([account("a", "reserve", 90), account("b", "unknown")])).toBeNull();
    expect(roomiest([])).toBeNull();
  });
});

