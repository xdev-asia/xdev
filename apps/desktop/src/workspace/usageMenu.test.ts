import { afterEach, expect, it, vi } from "vitest";
import { USAGE_DEFAULTS } from "@/settings/usageDefaults";
import { EMPTY_CTA_KEY, loadEmptyCtaHidden, saveEmptyCtaHidden, usageMenuItems } from "./usageMenu";

afterEach(() => vi.unstubAllGlobals());

it("lists both provider switches, a separator and the settings row", () => {
  const items = usageMenuItems({ ...USAGE_DEFAULTS, footer: { claude: true, codex: false } }, () => {}, () => {});
  expect(items.map((i) => i.id)).toEqual(["footer.claude", "footer.codex", "sep", "settings"]);
  expect(items.map((i) => i.checked)).toEqual([true, false, undefined, undefined]);
  expect(items[2]!.kind).toBe("separator");
  expect(items[0]!.labelKey).toBe("settings.usage.footer.claude");
  expect(items[3]!.labelKey).toBe("usage.menu.settings");
});

it("picking a provider flips only that switch", () => {
  const put = vi.fn();
  usageMenuItems(USAGE_DEFAULTS, put)[0]!.run!();
  expect(put).toHaveBeenCalledWith({ ...USAGE_DEFAULTS, footer: { claude: false, codex: true } });
  usageMenuItems(USAGE_DEFAULTS, put)[1]!.run!();
  expect(put).toHaveBeenLastCalledWith({ ...USAGE_DEFAULTS, footer: { claude: true, codex: false } });
});

it("has no settings row or separator without an opener", () => {
  expect(usageMenuItems(USAGE_DEFAULTS, () => {}).map((i) => i.id)).toEqual(["footer.claude", "footer.codex"]);
});

it("the hidden flag is false when missing, garbage or unreadable", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  expect(loadEmptyCtaHidden()).toBe(false);
  store.set(EMPTY_CTA_KEY, "banana");
  expect(loadEmptyCtaHidden()).toBe(false);
  saveEmptyCtaHidden(true);
  expect(store.get(EMPTY_CTA_KEY)).toBe("1");
  expect(loadEmptyCtaHidden()).toBe(true);
  vi.stubGlobal("localStorage", { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } });
  expect(loadEmptyCtaHidden()).toBe(false);
  expect(() => saveEmptyCtaHidden(true)).not.toThrow();
});
