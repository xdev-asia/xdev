import { expect, it, vi } from "vitest";
import type { Automation } from "@/api";
import { mount } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { AutomationList } from "./AutomationList";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const automation = { id: "a1", name: "Audit", enabled: true } as Automation;

function view(onSelect = vi.fn()) {
  const m = mount(AutomationList, () => ({
    rows: [{ automation, lastRun: null, project: "xdev" }],
    sort: null,
    onSort: vi.fn(),
    selected: "a1",
    onSelect,
    onAction: vi.fn(),
    schedules: { a1: "Daily at 9:00 AM" },
    now: 0,
  }));
  return m.all();
}

it("is a grid, so a row may say it is selected", () => {
  const all = view();
  expect(all.find((n) => n.type === "table")!.props.role).toBe("grid");
  expect(all.find((n) => n.props["data-act"] === "row")!.props["aria-selected"]).toBe(true);
});

it("opening the actions menu does not select the row", () => {
  const onSelect = vi.fn();
  const all = view(onSelect);
  const stopPropagation = vi.fn();
  all.find((n) => n.type === "td" && n.props.className === "au-actions")!.props.onClick?.({ stopPropagation });
  expect(stopPropagation).toHaveBeenCalled();
});

it("pauses and resumes from a switch in the row", async () => {
  const { Switch } = await import("@xdev-asia/ui");
  const onAction = vi.fn();
  const m = mount(AutomationList, () => ({
    rows: [{ automation, lastRun: null, project: "xdev" }],
    sort: null,
    onSort: vi.fn(),
    selected: null,
    onSelect: vi.fn(),
    onAction,
    schedules: {},
    now: 0,
  }));
  const toggle = m.all().find((n) => n.type === Switch)!;
  expect(toggle.props.checked).toBe(true);
  toggle.props.onChange();
  expect(onAction).toHaveBeenCalledWith("a1", "toggle");
}, 5000);
