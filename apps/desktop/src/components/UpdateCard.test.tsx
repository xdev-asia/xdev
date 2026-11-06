import { createElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { Button, Disclosure, IconButton } from "@xdev-asia/ui";
import { mount, textOf } from "@/kit/testHooks";
import { translate } from "@/i18n";
import type { Update } from "@/shell/useUpdate";
import { resetUpdateCardForTests, UpdateCard } from "./UpdateCard";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
// The mount helper needs an element; a card with nothing to show becomes an empty marker.
const Card = (p: Parameters<typeof UpdateCard>[0]) => UpdateCard(p) ?? createElement("i", { "data-empty": "" });
const empty = (m: { all(): { type: unknown }[] }) => m.all().length === 1 && m.all()[0].type === "i";
const ready: Update = { version: "1.2.0", notes: "Faster start.", status: "ready" };

beforeEach(resetUpdateCardForTests);

it("renders nothing without an update", () => {
  const m = mount(Card, () => ({ update: null, onRestart: vi.fn() }));
  expect(empty(m)).toBe(true);
});

it("shows the version, one primary button and collapsed release notes", () => {
  const onRestart = vi.fn();
  const m = mount(Card, () => ({ update: ready, onRestart }));
  expect(textOf(m.all().find((n) => n.type === "strong")!)).toBe(t("update.card.title", { version: "1.2.0" }));
  const buttons = m.all().filter((n) => n.type === Button);
  expect(buttons.length).toBe(1);
  expect(textOf(buttons[0])).toBe(t("update.card.restart"));
  expect(m.all().find((n) => n.type === Disclosure)!.props.defaultExpanded).toBe(false);
  buttons[0].props.onClick();
  expect(onRestart).toHaveBeenCalledTimes(1);
});

it("has no release notes row when the update has none", () => {
  const m = mount(Card, () => ({ update: { ...ready, notes: null }, onRestart: vi.fn() }));
  expect(m.all().some((n) => n.type === Disclosure)).toBe(false);
});

it("disables the button while restarting and says so after a failure", () => {
  const busy = mount(Card, () => ({ update: { ...ready, status: "restarting" as const }, onRestart: vi.fn() }));
  expect(busy.all().find((n) => n.type === Button)!.props.disabled).toBe(true);
  const failed = mount(Card, () => ({ update: { ...ready, status: "failed" as const }, onRestart: vi.fn() }));
  expect(failed.all().some((n) => textOf(n) === t("status.updateFailed"))).toBe(true);
});

it("goes away when dismissed and stays away for that version", () => {
  const m = mount(Card, () => ({ update: ready, onRestart: vi.fn() }));
  m.all().find((n) => n.type === IconButton)!.props.onClick();
  expect(empty(m)).toBe(true);
  const again = mount(Card, () => ({ update: ready, onRestart: vi.fn() }));
  expect(empty(again)).toBe(true);
  const newer = mount(Card, () => ({ update: { ...ready, version: "1.3.0" }, onRestart: vi.fn() }));
  expect(empty(newer)).toBe(false);
});
