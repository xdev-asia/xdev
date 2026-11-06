import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Badge, Button } from "@xdev-asia/ui";
import { translate } from "@/i18n";

const upsell = vi.hoisted(() => vi.fn());
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useContext: () => upsell }));
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

import { HISTORY_FEATURE, UsageHistoryLocked, chartDays, csvOf } from "./UsageHistory";

type Node = ReactElement<Record<string, any>>;
const flat = (n: unknown): Node[] => (Array.isArray(n) ? n.flatMap(flat) : n && typeof n === "object" && "props" in n ? [n as Node, ...flat((n as Node).props.children)] : []);

const days = [
  { day: "2026-11-01", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  { day: "2026-11-02", input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
];

it("the CSV has a header and one row per day", () => {
  expect(csvOf(days)).toBe("day,input,output,cache_read,cache_write\n2026-11-01,1,2,3,4\n2026-11-02,5,6,7,8\n");
  expect(csvOf([])).toBe("day,input,output,cache_read,cache_write\n");
});

it("the chart takes the days with snake-case token names", () => {
  expect(chartDays(days)[1]).toEqual(["2026-11-02", { input: 5, output: 6, cache_read: 7, cache_write: 8 }]);
});

it("free: the locked row is one secondary Pro button that opens the upsell for usage history", () => {
  upsell.mockClear();
  const out = UsageHistoryLocked() as Node;
  const button = flat(out).find((n) => n.type === Button)!;
  expect(button.props.variant).toBe("secondary");
  expect(button.props.type).toBe("button");
  expect(flat(out).some((n) => n.type === Badge)).toBe(true);
  button.props.onClick();
  expect(upsell).toHaveBeenCalledWith("pro.usage_history");
  expect(HISTORY_FEATURE).toBe("pro.usage_history");
});
