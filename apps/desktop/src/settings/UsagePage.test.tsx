import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { UsageChart } from "@/kit/UsageChart";
import { mount, nodes, textOf, tick, type Node } from "@/kit/testHooks";
import { USAGE_DEFAULTS } from "./usageDefaults";
import { getUsageSettings, resetUsageSettingsForTests, setUsageSettings } from "./usageSettings";
import { runSearch } from "./searchModel";
import { Badge, Heatmap } from "@xdev-asia/ui";
import { TokenTable } from "@/kit/UsageTab";
import { UsagePage } from "./UsagePage";
import { UsageRecentSessions } from "./UsageRecentSessions";
import { UsageShare } from "./UsageShare";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const field = (all: Node[], name: string) => all.find((n) => n.props["data-field"] === name)!;
const act = (all: Node[], name: string) => all.find((n) => n.props["data-act"] === name);
const tile = (all: Node[], key: string) => all.find((n) => n.props["data-tile"] === key)!;

async function open(scan = { claude: true, codex: false }) {
  resetUsageSettingsForTests();
  const api = createMockApi({});
  await api.usageSettingsPut({ ...USAGE_DEFAULTS, scan });
  const report = vi.spyOn(api, "kitUsageReport");
  const m = mount(UsagePage, () => ({ api, onChanged: vi.fn() }));
  await m.settle();
  await m.settle();
  return { api, m, report };
}

it("starts on Overview, xDev worktrees only and 30 days, and shows the tiles and the chart", async () => {
  const { m, report } = await open();
  const all = m.all();
  expect(field(all, "provider").props.value).toBe("overview");
  expect(field(all, "scope").props.value).toBe("xdev");
  expect(field(all, "range").props.value).toBe("30");
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]![0]).toMatchObject({ agent: null, scope: "xdev", refresh: true });
  expect(report.mock.calls[0]![0].sinceDay).not.toBeNull();
  expect(textOf(tile(all, "sessions"))).toContain(en("usage.stats.tile.sessions"));
  expect(all.some((n) => n.type === UsageChart)).toBe(true);
  // Codex is off: a line and its Enable button, no Claude one.
  expect(act(all, "enable-codex")).toBeDefined();
  expect(act(all, "enable-claude")).toBeUndefined();
});

it("All time asks with no start day, and the tracking date does not move", async () => {
  const { m, report } = await open();
  const before = textOf(tile(m.all(), "since"));
  field(m.all(), "range").props.onChange({ target: { value: "all" } });
  await m.settle();
  await m.settle();
  expect(report.mock.calls.at(-1)![0]).toMatchObject({ sinceDay: null, refresh: false });
  expect(textOf(tile(m.all(), "since"))).toBe(before);
});

it("Enable writes usage.scan, updates the store and reads again with a refresh", async () => {
  const { api, m, report } = await open();
  const put = vi.spyOn(api, "usageSettingsPut");
  act(m.all(), "enable-codex")!.props.onClick();
  await tick();
  await m.settle();
  await m.settle();
  expect(put).toHaveBeenCalledWith({ ...USAGE_DEFAULTS, scan: { claude: true, codex: true } });
  expect(getUsageSettings().scan.codex).toBe(true);
  expect(report.mock.calls.at(-1)![0]).toMatchObject({ refresh: true });
  expect(act(m.all(), "enable-codex")).toBeUndefined();
});

it("with a provider's scan off there is no read, only the text and Enable", async () => {
  const { m, report } = await open({ claude: false, codex: false });
  expect(report).not.toHaveBeenCalled();
  const all = m.all();
  expect(act(all, "enable-claude")).toBeDefined();
  expect(act(all, "enable-codex")).toBeDefined();
  expect(all.some((n) => n.type === UsageChart)).toBe(false);
  field(all, "provider").props.onChange({ target: { value: "claude" } });
  expect(act(m.all(), "enable-codex")).toBeUndefined();
});

it("shows the empty state when the range holds nothing", async () => {
  const { api, m } = await open();
  vi.spyOn(api, "kitUsageReport").mockResolvedValue({
    summary: { days: [], by_home: [], by_folder: [], by_model: [], top_sessions: [] },
    by_agent: [],
    sessions: 0,
    tracking_since: null,
    cost: { nanos: 0, unpriced: false, priced: false },
    cost_by_agent: [],
    recent_sessions: [],
    prices_as_of: "2026-11-04",
  });
  act(m.all(), "refresh")!.props.onClick();
  await m.settle();
  await m.settle();
  expect(m.all().some((n) => n.props.className === "kit-empty" && textOf(n) === en("usage.stats.empty"))).toBe(true);
});

it("a failed read shows the error code", async () => {
  const { api, m } = await open();
  vi.spyOn(api, "kitUsageReport").mockRejectedValue({ code: "io" });
  act(m.all(), "refresh")!.props.onClick();
  await m.settle();
  await m.settle();
  expect(m.all().some((n) => n.props.role === "alert" && textOf(n) === en("error.io"))).toBe(true);
});

// --- the usage settings rows ---

const sw = (all: Node[], id: string) => all.find((n) => n.props["data-switch"] === id)!;
const toggle = (all: Node[], id: string) => nodes(sw(all, id).props.children).find((n) => n.props.role === "switch")!;

it("Used / Remaining writes the display and updates the shared copy", async () => {
  const { api, m } = await open();
  const put = vi.spyOn(api, "usageSettingsPut");
  m.all().find((n) => n.props["data-display"] === "remaining")!.props.onClick();
  await tick();
  expect(put).toHaveBeenCalledWith({ ...USAGE_DEFAULTS, scan: { claude: true, codex: false }, display: "remaining" });
  expect(getUsageSettings().display).toBe("remaining");
  expect((await api.usageSettings()).display).toBe("remaining");
  const checked = (d: string) => m.all().find((n) => n.props["data-display"] === d)!.props["aria-checked"];
  await m.settle();
  expect([checked("used"), checked("remaining")]).toEqual([false, true]);
});

it("a save starts from the shared copy, so a change made elsewhere is kept", async () => {
  const { api, m } = await open();
  // Another window part changed the cache timer after the page loaded.
  setUsageSettings({ ...getUsageSettings(), cacheTimer: true });
  const put = vi.spyOn(api, "usageSettingsPut");
  m.all().find((n) => n.props["data-display"] === "remaining")!.props.onClick();
  await tick();
  expect(put).toHaveBeenCalledWith({ ...USAGE_DEFAULTS, scan: { claude: true, codex: false }, cacheTimer: true, display: "remaining" });
});

it("each footer and scan switch stores its own flag", async () => {
  const { api, m } = await open();
  for (const [id, group, agent] of [
    ["usage.footer.claude", "footer", "claude"],
    ["usage.footer.codex", "footer", "codex"],
    ["usage.scan.claude", "scan", "claude"],
    ["usage.scan.codex", "scan", "codex"],
  ] as const) {
    const before = (await api.usageSettings())[group][agent];
    toggle(m.all(), id).props.onClick();
    await tick();
    await m.settle();
    expect((await api.usageSettings())[group][agent], id).toBe(!before);
    expect(getUsageSettings()[group][agent], id).toBe(!before);
  }
});

it("a scan switch turned on reads again with a refresh; the display does not", async () => {
  const { m, report } = await open();
  m.all().find((n) => n.props["data-display"] === "remaining")!.props.onClick();
  await tick();
  await m.settle();
  expect(report).toHaveBeenCalledTimes(1);
  toggle(m.all(), "usage.scan.codex").props.onClick();
  await tick();
  await m.settle();
  await m.settle();
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls[1]![0]).toMatchObject({ refresh: true });
});

it("a search for remaining or con lai finds the display row", () => {
  const t = (key: string) => translate("en", key);
  for (const q of ["remaining", "con lai", "còn lại"]) {
    expect(runSearch(q, t, (s) => s).ids.has("usage.display"), q).toBe(true);
  }
});

it("the cache timer switch stores its flag, and the lifetime row shows only while it is on", async () => {
  const { api, m } = await open();
  const ttl = (all: Node[]) => all.filter((n) => n.props["data-cache-ttl"] !== undefined);
  expect(ttl(m.all())).toHaveLength(0);
  toggle(m.all(), "usage.cacheTimer").props.onClick();
  await tick();
  await m.settle();
  expect((await api.usageSettings()).cacheTimer).toBe(true);
  expect(ttl(m.all())).toHaveLength(2);
  ttl(m.all()).find((n) => n.props["data-cache-ttl"] === 3_600_000)!.props.onClick();
  await tick();
  expect((await api.usageSettings()).cacheTtlMs).toBe(3_600_000);
  expect(getUsageSettings().cacheTtlMs).toBe(3_600_000);
});

// Cost, recent sessions, cache reuse and the heatmap.
const tk = (input: number, cache_read = 0, output = 0) => ({ input, output, cache_read, cache_write: 0 });
const session = (id: string, agent: "claude" | "codex", total = tk(1, 2, 3), model: string | null = "m") => ({
  id, home_id: `own-${agent}`, agent, folder: "/demo/xdev", model, first: 1, last: 2, total, days: {},
});
function fixture(over: Partial<Awaited<ReturnType<ReturnType<typeof createMockApi>["kitUsageReport"]>>> = {}) {
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return {
    summary: { days: [[day, tk(100, 50, 10)]] as [string, ReturnType<typeof tk>][], by_home: [], by_folder: [], by_model: [], top_sessions: [] },
    by_agent: [["claude", tk(1, 2, 5)], ["codex", tk(3)]] as ["claude" | "codex", ReturnType<typeof tk>][],
    sessions: 2,
    tracking_since: 1,
    cost: { nanos: 12_340_000_000, unpriced: false, priced: true },
    cost_by_agent: [["claude", { nanos: 12_000_000_000, unpriced: false, priced: true }], ["codex", { nanos: 4_200_000, unpriced: false, priced: true }]] as ["claude" | "codex", { nanos: number; unpriced: boolean; priced: boolean }][],
    recent_sessions: [session("s1", "claude"), session("s2", "claude", tk(0), null)],
    prices_as_of: "2026-11-04",
    ...over,
  };
}
async function show(over: Parameters<typeof fixture>[0], provider = "overview") {
  const ctx = await open({ claude: true, codex: true });
  vi.spyOn(ctx.api, "kitUsageReport").mockResolvedValue(fixture(over));
  field(ctx.m.all(), "provider").props.onChange({ target: { value: provider } });
  if (provider === "overview") act(ctx.m.all(), "refresh")!.props.onClick();
  await ctx.m.settle();
  await ctx.m.settle();
  return ctx;
}
const ofType = (all: Node[], type: unknown) => all.filter((n) => n.type === type);

it("the cost tile shows the estimate and the price date", async () => {
  const { m } = await show({});
  const cost = tile(m.all(), "cost");
  expect(textOf(cost)).toContain(en("usage.stats.tile.cost"));
  expect(textOf(cost)).toContain("$12.34");
  expect(textOf(cost)).not.toContain(en("usage.stats.cost.excludes"));
  expect(cost.props.title).toBe(en("usage.stats.cost.asOf", { date: "2026-11-04" }));
});

it("the cost tile says what it leaves out, and shows n/a when nothing is priced", async () => {
  const some = await show({ cost: { nanos: 5_000_000, unpriced: true, priced: true } });
  expect(textOf(tile(some.m.all(), "cost"))).toContain("$0.0050");
  expect(textOf(tile(some.m.all(), "cost"))).toContain(en("usage.stats.cost.excludes"));
  const none = await show({ cost: { nanos: 0, unpriced: true, priced: false } });
  expect(textOf(tile(none.m.all(), "cost"))).toContain("n/a");
  expect(textOf(tile(none.m.all(), "cost"))).not.toContain(en("usage.stats.cost.excludes"));
});

it("Overview shows the cost by provider, a 42-day heatmap and the busiest day, and no recent table", async () => {
  const { m } = await show({});
  const all = m.all();
  const table = ofType(all, TokenTable).find((n) => n.props.title === en("usage.stats.byProvider"))!;
  expect(table.props.costs).toEqual({ Claude: "$12.00", Codex: "$0.0042" });
  const heat = ofType(all, Heatmap)[0]!;
  expect(heat.props.cells).toHaveLength(42);
  expect(heat.props.cells.some((c: { level: number }) => c.level === 4)).toBe(true);
  expect(ofType(all, Badge)).toHaveLength(1);
  expect(ofType(all, UsageRecentSessions)).toHaveLength(0);
});

it("Claude shows the cache reuse rate with its note and the recent sessions", async () => {
  const { m } = await show({}, "claude");
  const all = m.all();
  const line = all.find((n) => "data-cache-line" in n.props)!;
  expect(textOf(line)).toContain(en("usage.stats.cache.reuse", { percent: 67 }));
  expect(textOf(line)).toContain(en("usage.stats.cache.note"));
  expect(ofType(all, UsageRecentSessions)[0]!.props.agent).toBe("claude");
  expect(ofType(all, Heatmap)).toHaveLength(0);
});

it("Codex shows its recent sessions and no cache line", async () => {
  const { m } = await show({ by_agent: [["codex", tk(3)]] }, "codex");
  const all = m.all();
  expect(all.some((n) => "data-cache-line" in n.props)).toBe(false);
  expect(ofType(all, UsageRecentSessions)[0]!.props.agent).toBe("codex");
});

it("recent sessions: Claude has a cache column, Codex a total column, and a missing model is named", () => {
  const sessions = [session("abcdef123456", "claude", tk(1, 3)), session("zzzz", "claude", tk(0), null)];
  const claude = mount(UsageRecentSessions, () => ({ agent: "claude" as const, sessions })).all();
  expect(claude.filter((n) => n.type === "th").map(textOf)).toContain(en("usage.stats.cache.col"));
  expect(claude.filter((n) => n.type === "th").map(textOf)).not.toContain(en("kit.usage.total"));
  expect(claude.filter((n) => "data-cache" in n.props).map(textOf)).toEqual(["75%", "–"]);
  expect(claude.some((n) => n.type === "td" && textOf(n) === en("usage.stats.recent.unknownModel"))).toBe(true);
  expect(claude.some((n) => n.type === "td" && textOf(n) === "abcdef12")).toBe(true);
  const codex = mount(UsageRecentSessions, () => ({ agent: "codex" as const, sessions })).all();
  expect(codex.filter((n) => n.type === "th").map(textOf)).toContain(en("kit.usage.total"));
  expect(codex.find((n) => "data-recent-desc" in n.props)!.props.children).toBe(en("usage.stats.recent.desc.codex"));
});

it("the share button is on a Claude or Codex page with the figures of that agent, and not on Overview", async () => {
  expect(ofType((await show({})).m.all(), UsageShare)).toHaveLength(0);
  const { m } = await show({ summary: { ...fixture().summary, by_model: [["claude-opus-4-5", tk(9)]] } }, "claude");
  const share = ofType(m.all(), UsageShare);
  expect(share).toHaveLength(1);
  const data = share[0]!.props.data as { provider: string; sessions: number; topModel: string | null; tokens: number };
  expect(data.provider).toBe("claude");
  expect(data.sessions).toBe(2);
  expect(data.topModel).toBe("claude-opus-4-5");
  expect(data.tokens).toBeGreaterThan(0);
  expect(ofType((await show({}, "codex")).m.all(), UsageShare)).toHaveLength(1);
});
