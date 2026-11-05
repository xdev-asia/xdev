import { describe, expect, it } from "vitest";
import type { BaseRange } from "@/api";
import { translate } from "@/i18n";
import { breakdownRows, countsAria } from "./shipBreakdown";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const range = (over: Partial<BaseRange> = {}): BaseRange => ({
  mergeBase: "m",
  added: 30,
  removed: 10,
  tests: { added: 12, removed: 2 },
  generated: { added: 0, removed: 0 },
  commits: [],
  truncated: false,
  ...over,
});

describe("breakdownRows", () => {
  it("splits source, tests and generated; source is what is left of the total", () => {
    expect(breakdownRows(range({ generated: { added: 8, removed: 1 } }))).toEqual([
      { id: "source", label: "ship.breakdown.source", added: 10, removed: 7 },
      { id: "tests", label: "ship.breakdown.tests", added: 12, removed: 2 },
      { id: "generated", label: "ship.breakdown.generated", added: 8, removed: 1 },
    ]);
  });

  it("shows Tests even at zero and hides Generated at zero", () => {
    const rows = breakdownRows(range({ tests: { added: 0, removed: 0 } }));
    expect(rows.map((r) => r.id)).toEqual(["source", "tests"]);
    expect(rows[0]).toMatchObject({ added: 30, removed: 10 });
    expect(rows[1]).toMatchObject({ added: 0, removed: 0 });
    // Generated with only removed lines still shows.
    expect(breakdownRows(range({ generated: { added: 0, removed: 3 } })).map((r) => r.id)).toEqual(["source", "tests", "generated"]);
  });

  it("never shows a negative source", () => {
    const rows = breakdownRows(range({ added: 5, removed: 0, tests: { added: 9, removed: 1 } }));
    expect(rows[0]).toMatchObject({ added: 0, removed: 0 });
  });
});

describe("countsAria", () => {
  it("adds the test part, then the generated part, only when non-zero", () => {
    const plain = en("ship.breakdown.aria", { added: 30, removed: 10 });
    expect(countsAria(range({ tests: { added: 0, removed: 0 } }), en)).toBe(plain);
    expect(countsAria(range(), en)).toBe(`${plain}${en("ship.breakdown.ariaTests", { added: 12, removed: 2 })}`);
    expect(countsAria(range({ generated: { added: 4, removed: 0 } }), en)).toBe(
      `${plain}${en("ship.breakdown.ariaTests", { added: 12, removed: 2 })}${en("ship.breakdown.ariaGenerated", { added: 4, removed: 0 })}`,
    );
    expect(countsAria(range(), en)).toContain(" — test code: 12 lines added, 2 lines deleted");
  });
});
