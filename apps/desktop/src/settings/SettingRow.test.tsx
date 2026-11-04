import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FLASH_CLASS, revealSetting, SettingGroup, SettingRow, settingShown } from "./SettingRow";
import type { SettingsFilter } from "./sections";

const filter = (...ids: string[]): SettingsFilter => ({ query: "x", ids: new Set(ids) });

it("renders its children, tagged with the id, when no search is set", () => {
  const el = SettingRow({ id: "a.b", children: "x" })!;
  expect(el.props["data-setting-id"]).toBe("a.b");
  expect(el.props.children).toBe("x");
});

it("renders nothing while a search is set and the id is not a hit", () => {
  expect(SettingRow({ id: "a.b", filter: filter("a.c"), children: "x" })).toBeNull();
  expect(SettingRow({ id: "a.b", filter: filter("a.b"), children: "x" })).not.toBeNull();
  expect(settingShown(filter(), "a.b")).toBe(false);
  expect(settingShown(undefined, "a.b")).toBe(true);
});

it("a group shows when any of its ids is a hit", () => {
  expect(SettingGroup({ ids: ["a", "b"], filter: filter("b"), children: "x" })).not.toBeNull();
  expect(SettingGroup({ ids: ["a", "b"], filter: filter("c"), children: "x" })).toBeNull();
  expect(SettingGroup({ ids: ["a"], children: "x" })).not.toBeNull();
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeEl() {
  const classes = new Set<string>();
  return {
    classes,
    scrollIntoView: vi.fn(),
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
  };
}

it("reveal scrolls to the control and flashes it once", () => {
  const el = fakeEl();
  revealSetting(() => el);
  expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
  expect(el.classes.has(FLASH_CLASS)).toBe(true);
  vi.advanceTimersByTime(2000);
  expect(el.classes.has(FLASH_CLASS)).toBe(false);
  expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
});

it("reveal waits for a page that is still loading, then gives up", () => {
  const el = fakeEl();
  let ready = false;
  revealSetting(() => (ready ? el : null));
  vi.advanceTimersByTime(500);
  expect(el.scrollIntoView).not.toHaveBeenCalled();
  ready = true;
  vi.advanceTimersByTime(100);
  expect(el.scrollIntoView).toHaveBeenCalledTimes(1);

  const find = vi.fn(() => null);
  revealSetting(find);
  vi.advanceTimersByTime(10_000);
  expect(find.mock.calls.length).toBeLessThanOrEqual(32);
});

it("reveal can be stopped", () => {
  const el = fakeEl();
  const stop = revealSetting(() => null);
  stop();
  vi.advanceTimersByTime(1000);
  expect(el.scrollIntoView).not.toHaveBeenCalled();
});
