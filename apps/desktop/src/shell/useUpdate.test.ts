import { describe, expect, it } from "vitest";
import { nextUpdate, type Update } from "./useUpdate";

const ready: Update = { version: "0.3.0", notes: null, status: "ready" };

describe("nextUpdate", () => {
  it("a found release is ready to install", () => {
    expect(nextUpdate(null, { kind: "found", version: "0.3.0", notes: "Fixes" })).toEqual({ version: "0.3.0", notes: "Fixes", status: "ready" });
  });

  it("a later check does not interrupt an install", () => {
    const installing = nextUpdate(ready, { kind: "installing" });
    expect(installing?.status).toBe("installing");
    expect(nextUpdate(installing, { kind: "found", version: "0.3.1", notes: null })).toBe(installing);
    expect(nextUpdate(installing, { kind: "none" })).toBe(installing);
  });

  it("a failed install can be tried again", () => {
    const failed = nextUpdate(nextUpdate(ready, { kind: "installing" }), { kind: "failed" });
    expect(failed).toEqual({ ...ready, status: "failed" });
    expect(nextUpdate(failed, { kind: "found", version: "0.3.0", notes: null })?.status).toBe("ready");
  });

  it("nothing to install clears the item", () => {
    expect(nextUpdate(ready, { kind: "none" })).toBeNull();
    expect(nextUpdate(null, { kind: "installing" })).toBeNull();
  });
});
