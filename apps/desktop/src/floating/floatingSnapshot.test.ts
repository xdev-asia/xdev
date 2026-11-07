import { describe, expect, it } from "vitest";
import {
  FLOATING_VERSION,
  NOTE_MAX_BYTES,
  NOTE_MAX_TABS,
  parseFloatingSnapshot,
  type FloatingSnapshot,
} from "./floatingSnapshot";

const good: FloatingSnapshot = {
  version: FLOATING_VERSION,
  savedAt: "2026-11-07T00:00:00.000Z",
  active: 1,
  tabs: [
    { kind: "terminal", id: "floating-term-a", n: 1, cwd: "/work", seq: 10 },
    { kind: "browser", url: "https://example.com", title: "Example" },
    { kind: "note", n: 1, body: "hi" },
  ],
};

describe("parseFloatingSnapshot", () => {
  it("round-trips a valid value", () => {
    expect(parseFloatingSnapshot(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it("returns null for a wrong version, a non-object or non-array tabs", () => {
    expect(parseFloatingSnapshot({ ...good, version: 2 })).toBeNull();
    expect(parseFloatingSnapshot("x")).toBeNull();
    expect(parseFloatingSnapshot(null)).toBeNull();
    expect(parseFloatingSnapshot([good])).toBeNull();
    expect(parseFloatingSnapshot({ ...good, tabs: {} })).toBeNull();
  });

  it("drops rows it cannot use", () => {
    const out = parseFloatingSnapshot({
      ...good,
      active: 0,
      tabs: [
        { kind: "ftp" },
        { kind: "terminal", n: 2 },
        { kind: "browser", url: 3 },
        { kind: "note", n: 1, body: 5 },
        "junk",
        { kind: "note", n: 2, body: "ok" },
      ],
    });
    expect(out?.tabs).toEqual([{ kind: "note", n: 2, body: "ok" }]);
  });

  it("cuts a long note at a character boundary", () => {
    const body = "é".repeat(NOTE_MAX_BYTES); // 2 bytes each
    const out = parseFloatingSnapshot({ ...good, tabs: [{ kind: "note", n: 1, body }] });
    const kept = (out?.tabs[0] as { body: string }).body;
    expect(new TextEncoder().encode(kept).length).toBeLessThanOrEqual(NOTE_MAX_BYTES);
    expect(kept).toBe("é".repeat(NOTE_MAX_BYTES / 2));
    const odd = parseFloatingSnapshot({ ...good, tabs: [{ kind: "note", n: 1, body: "a" + "é".repeat(NOTE_MAX_BYTES) }] });
    expect((odd?.tabs[0] as { body: string }).body).toBe("a" + "é".repeat((NOTE_MAX_BYTES - 1) / 2 | 0));
  });

  it("drops notes past the cap", () => {
    const tabs = Array.from({ length: NOTE_MAX_TABS + 2 }, (_, i) => ({ kind: "note", n: i + 1, body: "x" }));
    expect(parseFloatingSnapshot({ ...good, active: 0, tabs })?.tabs).toHaveLength(NOTE_MAX_TABS);
  });

  it("puts an out-of-range active on the first tab, or null with no tabs", () => {
    expect(parseFloatingSnapshot({ ...good, active: 9 })?.active).toBe(0);
    expect(parseFloatingSnapshot({ ...good, active: "x" })?.active).toBe(0);
    expect(parseFloatingSnapshot({ ...good, active: 0, tabs: [] })?.active).toBeNull();
  });

  it("keeps active on the same row when earlier rows are dropped", () => {
    const out = parseFloatingSnapshot({ ...good, active: 2, tabs: [{ kind: "x" }, good.tabs[1], good.tabs[2]] });
    expect(out?.active).toBe(1);
  });
});
