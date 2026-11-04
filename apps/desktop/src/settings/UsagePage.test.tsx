import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { UsageChart } from "@/kit/UsageChart";
import { mount, textOf, tick, type Node } from "@/kit/testHooks";
import { USAGE_DEFAULTS } from "./usageDefaults";
import { getUsageSettings, resetUsageSettingsForTests } from "./usageSettings";
import { UsagePage } from "./UsagePage";

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
