import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { UsageChart } from "@/kit/UsageChart";
import { mount, nodes, textOf, tick, type Node } from "@/kit/testHooks";
import { USAGE_DEFAULTS } from "./usageDefaults";
import { getUsageSettings, resetUsageSettingsForTests, setUsageSettings } from "./usageSettings";
import { runSearch } from "./searchModel";
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

it("lists the accounts with their status, reads once on open and once per Check again, and signs in", async () => {
  const { api, m } = await open();
  const quota = vi.spyOn(api, "quota");
  const accounts = vi.spyOn(api, "accounts");
  const login = vi.spyOn(api, "loginAccount").mockResolvedValue({ opened: true, command: "x" });
  const fresh = mount(UsagePage, () => ({ api, onChanged: vi.fn() }));
  await fresh.settle();
  await fresh.settle();
  expect(quota).toHaveBeenCalledTimes(1);
  const rows = fresh.all().filter((n) => n.props["data-credential"]);
  expect(rows.length).toBeGreaterThan(0);
  let reads = 1;
  const signIn = fresh.all().find((n) => String(n.props["data-act"] ?? "").startsWith("signin-"));
  if (signIn) {
    signIn.props.onClick();
    await fresh.settle();
    expect(login).toHaveBeenCalledWith(String(signIn.props["data-act"]).slice("signin-".length));
    reads += 1; // Sign in looks once more when it finishes.
  }
  act(fresh.all(), "check-credentials")!.props.onClick();
  await fresh.settle();
  expect(quota).toHaveBeenCalledTimes(reads + 1);
  expect(accounts).toHaveBeenCalledTimes(reads + 1);
  expect(m.all().length).toBeGreaterThan(0);
});

it("checks the credentials once more after Sign in finishes", async () => {
  resetUsageSettingsForTests();
  const api = createMockApi({});
  const acct = { name: "a1", provider: "claude" as const, dir: "/x", status: { state: "logged_out" as const, email: null, plan: null, org: null } };
  vi.spyOn(api, "accounts").mockResolvedValue({ reservePercent: 30, accounts: [acct], active: [] });
  const quota = vi.spyOn(api, "quota").mockResolvedValue([{ name: "a1", state: "unknown", reason: "no_credentials", windows: [], asOf: null }]);
  const login = vi.spyOn(api, "loginAccount").mockResolvedValue({ opened: true, command: "x" });
  const m = mount(UsagePage, () => ({ api, onChanged: vi.fn() }));
  await m.settle();
  await m.settle();
  expect(quota).toHaveBeenCalledTimes(1);
  m.all().find((n) => n.props["data-act"] === "signin-a1")!.props.onClick();
  await m.settle();
  await m.settle();
  expect(login).toHaveBeenCalledWith("a1");
  expect(quota).toHaveBeenCalledTimes(2);
  login.mockRejectedValueOnce(new Error("x"));
  m.all().find((n) => n.props["data-act"] === "signin-a1")!.props.onClick();
  await m.settle();
  await m.settle();
  expect(quota).toHaveBeenCalledTimes(2);
});

it("shows an empty state when there are no accounts", async () => {
  resetUsageSettingsForTests();
  const api = createMockApi({});
  vi.spyOn(api, "accounts").mockResolvedValue({ reservePercent: 30, accounts: [], active: [] });
  const m = mount(UsagePage, () => ({ api, onChanged: vi.fn() }));
  await m.settle();
  await m.settle();
  expect(m.all().some((n) => n.props["data-field"] === "credentials-empty")).toBe(true);
});
