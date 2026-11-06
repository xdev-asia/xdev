import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { mount, nodes, type Node } from "@/kit/testHooks";
import { ProGate } from "@/license/ProGate";
import { USAGE_DEFAULTS } from "./usageDefaults";
import { resetUsageSettingsForTests } from "./usageSettings";
import { UsagePage } from "./UsagePage";
import { HISTORY_FEATURE, UsageHistory, UsageHistoryLocked } from "./UsageHistory";

const license = vi.hoisted(() => ({ allowed: false }));
vi.mock("@/license/useLicense", () => ({ useLicense: () => ({ allows: () => license.allowed }) }));
vi.mock("react", async (original) => ({ ...(await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()), useContext: () => () => undefined }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

async function open() {
  resetUsageSettingsForTests();
  const api = createMockApi({});
  await api.usageSettingsPut({ ...USAGE_DEFAULTS, scan: { claude: true, codex: false } });
  const m = mount(UsagePage, () => ({ api, onChanged: vi.fn() }));
  await m.settle();
  await m.settle();
  return m;
}
const field = (all: Node[], name: string) => all.find((n) => n.props["data-field"] === name)!;

it("the range picker offers the saved history after the CLI log ranges, tagged Pro", async () => {
  const m = await open();
  const values = nodes(field(m.all(), "range")).filter((n) => n.type === "option").map((n) => n.props.value);
  expect(values).toEqual(["7", "30", "90", "all", "history"]);
  expect(translate("en", "usage.stats.range.history")).toContain(translate("en", "pro.tag"));
  // No separate history block until the choice is made.
  expect(m.all().some((n) => n.type === ProGate)).toBe(false);
});

it("choosing the history wraps it in ProGate: the history with Pro, the locked row without", async () => {
  const m = await open();
  field(m.all(), "range").props.onChange({ target: { value: "history" } });
  const gate = m.all().find((n) => n.type === ProGate)!;
  expect(gate.props.feature).toBe(HISTORY_FEATURE);
  expect(field(m.all(), "range").props.value).toBe("history");

  license.allowed = true;
  const withPro = ProGate(gate.props as never) as Node;
  expect((withPro.props.children as Node).type).toBe(UsageHistory);
  license.allowed = false;
  const free = ProGate(gate.props as never) as Node;
  expect((free.props.children as Node).type).toBe(UsageHistoryLocked);

  // Going back to a log range hides it again.
  field(m.all(), "range").props.onChange({ target: { value: "30" } });
  expect(m.all().some((n) => n.type === ProGate)).toBe(false);
});
