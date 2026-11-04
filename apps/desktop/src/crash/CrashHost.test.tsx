import { describe, expect, it } from "vitest";
import { openCrashDialog, onCrashOpen } from "./crashEvents";

describe("crash events", () => {
  it("passes an open request to the host until it unsubscribes", () => {
    const seen: unknown[] = [];
    const off = onCrashOpen((o) => seen.push(o));
    openCrashDialog({ latest: true });
    off();
    openCrashDialog({ latest: true });
    expect(seen).toEqual([{ latest: true }]);
  });
});
