import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { mount, tick, type Node } from "@/kit/testHooks";
import { createMockMission } from "@/mockMission";
import { HandoffDialog, type HandoffDialogProps } from "./HandoffDialog";

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...(await import("@/kit/testHooks")).patchReact(react), useId: () => "h" };
});
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const Dlg = HandoffDialog as unknown as (p: HandoffDialogProps) => ReactElement;
const tabs = [
  { id: "demo-lead", title: "Lead" },
  { id: "demo-review", title: "Reviewer" },
  { id: "demo-builder", title: "Builder" },
];
const box = (all: Node[]) => all.find((n) => n.props.role === "combobox")!;
const options = (all: Node[]) => all.filter((n) => n.props.role === "option");
const field = { focus() {}, setSelectionRange() {} };
const type = (all: Node[], value: string) => box(all).props.onChange({ target: { ...field, value, selectionStart: value.length } });
const key = (k: string) => ({ key: k, preventDefault() {}, stopPropagation() {} });

function setup() {
  const api = createMockMission(() => 1);
  const sent: string[] = [];
  let closed = false;
  const m = mount(Dlg, () => ({ api, tabs, from: "demo-lead", onClose: () => (closed = true), onSent: (to: string) => void sent.push(to) }));
  return { api, m, sent, closed: () => closed };
}

it("opens the listbox of other live tabs on @ and moves through it with the arrow keys", () => {
  const { m } = setup();
  type(m.all(), "@");
  let all = m.all();
  expect(box(all).props["aria-expanded"]).toBe(true);
  expect(options(all).map((o) => o.props.children)).toEqual(["Reviewer", "Builder"]);
  expect(box(all).props["aria-activedescendant"]).toBe("h-opt-0");
  box(all).props.onKeyDown(key("ArrowDown"));
  all = m.all();
  expect(options(all)[1].props["aria-selected"]).toBe(true);
  box(all).props.onKeyDown(key("ArrowDown"));
  expect(options(m.all())[0].props["aria-selected"]).toBe(true);
});

it("Escape closes only the list, and Enter picks the tab into the text", () => {
  const { m, closed } = setup();
  type(m.all(), "@rev");
  box(m.all()).props.onKeyDown(key("Escape"));
  expect(box(m.all()).props["aria-expanded"]).toBe(false);
  expect(closed()).toBe(false);
  type(m.all(), "@re");
  box(m.all()).props.onKeyDown(key("Enter"));
  expect(box(m.all()).props.value).toBe("@Reviewer ");
});

it("hands the message to the named tab and leaves the button off until it can", async () => {
  const { api, m, sent } = setup();
  const dialog = () => m.draw() as Node;
  expect(dialog().props.confirmDisabled).toBe(true);
  type(m.all(), "@Reviewer check the retry");
  expect(dialog().props.confirmDisabled).toBe(false);
  expect(box(m.all()).props.hint).toBe(en("mission.handoff.to", { name: "Reviewer" }));
  dialog().props.onConfirm();
  await tick();
  expect(api.__handoffs()).toEqual([{ from: "demo-lead", to: "demo-review", text: "check the retry" }]);
  expect(sent).toEqual(["Reviewer"]);
});

it("does not hand off to the sending tab itself", () => {
  const { m } = setup();
  type(m.all(), "@Lead hello");
  expect((m.draw() as Node).props.confirmDisabled).toBe(true);
});

it("a picked title followed by a space keeps the list closed", () => {
  const { m } = setup();
  type(m.all(), "@Reviewer ");
  expect(box(m.all()).props["aria-expanded"]).toBe(false);
  type(m.all(), "@Reviewer please");
  expect(box(m.all()).props["aria-expanded"]).toBe(false);
});
