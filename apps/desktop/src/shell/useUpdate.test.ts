import { describe, expect, it } from "vitest";
import { firstSeen, nextUpdate, type Update } from "./useUpdate";

const ready: Update = { version: "0.3.0", notes: null, status: "ready" };

describe("nextUpdate", () => {
  it("a downloaded release is ready to restart into", () => {
    expect(nextUpdate(null, { kind: "ready", version: "0.3.0", notes: "Fixes" })).toEqual({ version: "0.3.0", notes: "Fixes", status: "ready" });
  });

  it("ready, notified once, restarting, then failed", () => {
    const seen = new Set<string>();
    const shown = nextUpdate(null, { kind: "ready", version: "0.3.0", notes: null });
    expect(firstSeen(seen, "0.3.0")).toBe(true);
    // The same version again, from the event and from `updateStatus`, is not announced twice.
    expect(firstSeen(seen, "0.3.0")).toBe(false);
    const restarting = nextUpdate(shown, { kind: "restarting" });
    expect(restarting?.status).toBe("restarting");
    expect(nextUpdate(restarting, { kind: "failed" })).toEqual({ ...ready, status: "failed" });
    expect(firstSeen(seen, "0.3.1")).toBe(true);
  });

  it("a restart handed to the quit guard frees the button again", () => {
    const restarting = nextUpdate(ready, { kind: "restarting" });
    expect(nextUpdate(restarting, { kind: "handed" })).toEqual(ready);
  });

  it("a newer download does not interrupt a restart", () => {
    const restarting = nextUpdate(ready, { kind: "restarting" });
    expect(nextUpdate(restarting, { kind: "ready", version: "0.3.1", notes: null })).toBe(restarting);
  });

  it("a failed restart can be tried again, and a newer download replaces it", () => {
    const failed = nextUpdate(nextUpdate(ready, { kind: "restarting" }), { kind: "failed" });
    expect(nextUpdate(failed, { kind: "ready", version: "0.3.1", notes: null })).toEqual({ ...ready, version: "0.3.1" });
  });

  it("nothing pending clears the item", () => {
    expect(nextUpdate(ready, { kind: "none" })).toBeNull();
    expect(nextUpdate(null, { kind: "restarting" })).toBeNull();
  });
});
