import { createElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { Button, Disclosure } from "@xdev-asia/ui";
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
const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
};
const DAY = 24 * 60 * 60 * 1000;
const empty = (m: { all(): { type: unknown }[] }) => m.all().length === 1 && m.all()[0].type === "i";
const ready: Update = { version: "1.2.0", notes: "Faster start.", status: "ready" };

let store = memory();
beforeEach(() => {
  store = memory();
  resetUpdateCardForTests(store);
});

it("renders nothing without an update", () => {
  const m = mount(Card, () => ({ update: null, onRestart: vi.fn(), nudge: { store } }));
  expect(empty(m)).toBe(true);
});

it("shows the version, one primary button and collapsed release notes", () => {
  const onRestart = vi.fn();
  const m = mount(Card, () => ({ update: ready, onRestart, nudge: { store } }));
  expect(textOf(m.all().find((n) => n.type === "strong")!)).toBe(t("update.card.title", { version: "1.2.0" }));
  const buttons = m.all().filter((n) => n.type === Button);
  expect(buttons.map((b) => textOf(b))).toEqual([t("update.card.restart"), t("update.card.remind"), t("update.card.skip")]);
  expect(buttons.filter((b) => b.props.variant !== "secondary")).toHaveLength(1);
  expect(buttons.every((b) => b.props.type === "button")).toBe(true);
  expect(m.all().find((n) => n.type === Disclosure)!.props.defaultExpanded).toBe(false);
  buttons[0].props.onClick();
  expect(onRestart).toHaveBeenCalledTimes(1);
});

it("has no release notes row when the update has none", () => {
  const m = mount(Card, () => ({ update: { ...ready, notes: null }, onRestart: vi.fn(), nudge: { store } }));
  expect(m.all().some((n) => n.type === Disclosure)).toBe(false);
});

it("disables the button while restarting and says so after a failure", () => {
  const busy = mount(Card, () => ({ update: { ...ready, status: "restarting" as const }, onRestart: vi.fn(), nudge: { store } }));
  expect(busy.all().find((n) => n.type === Button)!.props.disabled).toBe(true);
  const failed = mount(Card, () => ({ update: { ...ready, status: "failed" as const }, onRestart: vi.fn(), nudge: { store } }));
  expect(failed.all().some((n) => textOf(n) === t("status.updateFailed"))).toBe(true);
});

const act = (m: { all(): { type: unknown; props: Record<string, any> }[] }, name: string) => m.all().find((n) => n.props["data-act"] === name)!.props.onClick();

it("Remind me later hides the card until the delay has passed, 3 days by default", () => {
  let now = 1_000_000;
  const nudge = { now: () => now, store };
  const m = mount(Card, () => ({ update: ready, onRestart: vi.fn(), nudge }));
  act(m, "update-remind");
  expect(empty(m)).toBe(true);
  now += 3 * DAY - 1;
  expect(empty(mount(Card, () => ({ update: ready, onRestart: vi.fn(), nudge })))).toBe(true);
  now += 1;
  expect(empty(mount(Card, () => ({ update: ready, onRestart: vi.fn(), nudge })))).toBe(false);
});

it("uses the delay saved in Settings", () => {
  store.setItem("xdev.update.remindDays", "7");
  let now = 0;
  const nudge = { now: () => now, store };
  act(mount(Card, () => ({ update: ready, onRestart: vi.fn(), nudge })), "update-remind");
  now = 6 * DAY;
  expect(empty(mount(Card, () => ({ update: ready, onRestart: vi.fn(), nudge })))).toBe(true);
  now = 7 * DAY;
  expect(empty(mount(Card, () => ({ update: ready, onRestart: vi.fn(), nudge })))).toBe(false);
});

it("Skip this version stays away for that version and comes back for a newer one", () => {
  let now = 0;
  const nudge = { now: () => now, store };
  act(mount(Card, () => ({ update: ready, onRestart: vi.fn(), nudge })), "update-skip");
  now = 365 * DAY;
  expect(empty(mount(Card, () => ({ update: ready, onRestart: vi.fn(), nudge })))).toBe(true);
  expect(empty(mount(Card, () => ({ update: { ...ready, version: "1.3.0" }, onRestart: vi.fn(), nudge })))).toBe(false);
});

it("a newer version than the reminded one shows at once", () => {
  const nudge = { now: () => 0, store };
  act(mount(Card, () => ({ update: ready, onRestart: vi.fn(), nudge })), "update-remind");
  expect(empty(mount(Card, () => ({ update: { ...ready, version: "1.2.1" }, onRestart: vi.fn(), nudge })))).toBe(false);
});
