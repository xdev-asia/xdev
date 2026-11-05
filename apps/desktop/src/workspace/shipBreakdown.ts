import type { BaseRange } from "@/api";

type Say = (key: string, vars?: Record<string, string | number>) => string;

export type BreakdownRow = { id: "source" | "tests" | "generated"; label: string; added: number; removed: number };

/**
 * The Code breakdown rows of a branch's line count: Source (the total less tests and generated code,
 * never below zero), Tests (always) and Generated (only when it has lines). Pure.
 */
export function breakdownRows(range: BaseRange): BreakdownRow[] {
  const { tests, generated } = range;
  const rows: BreakdownRow[] = [
    {
      id: "source",
      label: "ship.breakdown.source",
      added: Math.max(0, range.added - tests.added - generated.added),
      removed: Math.max(0, range.removed - tests.removed - generated.removed),
    },
    { id: "tests", label: "ship.breakdown.tests", added: tests.added, removed: tests.removed },
  ];
  if (generated.added + generated.removed > 0) rows.push({ id: "generated", label: "ship.breakdown.generated", added: generated.added, removed: generated.removed });
  return rows;
}

/** The counts' accessible label: the total, then the test and generated parts when they have lines. */
export function countsAria(range: BaseRange, t: Say): string {
  let text = t("ship.breakdown.aria", { added: range.added, removed: range.removed });
  if (range.tests.added + range.tests.removed > 0) text += t("ship.breakdown.ariaTests", { added: range.tests.added, removed: range.tests.removed });
  if (range.generated.added + range.generated.removed > 0) {
    text += t("ship.breakdown.ariaGenerated", { added: range.generated.added, removed: range.generated.removed });
  }
  return text;
}
