import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Icons come from the design system's Icon; only drawings with no icon of their own (charts, rings, maps) stay inline.
const root = fileURLToPath(new URL("../", import.meta.url));
const DRAWINGS = new Set([
  "components/SquadsView.tsx",
  "kit/UsageChart.tsx",
  "orchestration/charts/ChartPreview.tsx",
  "orchestration/TeamMap.tsx",
  "workspace/TabIndicator.tsx",
]);

it("no inline svg icons in app sources", () => {
  const offenders: string[] = [];
  for (const entry of readdirSync(root, { recursive: true }) as string[]) {
    const file = entry.replaceAll("\\", "/");
    if (!file.endsWith(".tsx") || file.endsWith(".test.tsx") || DRAWINGS.has(file)) continue;
    if (readFileSync(join(root, entry), "utf8").includes("<svg")) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
