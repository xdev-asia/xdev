import { expect, it, vi } from "vitest";
import type { MenuEntry } from "@xdev-asia/ui";
import type { SimList } from "@/api";
import { translate } from "@/i18n";
import { simEntries } from "./SimsGroup";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const labels = (list: SimList | null, onPick = vi.fn()) => simEntries(list, t, onPick).map((e: MenuEntry) => ("label" in e ? e.label : "-"));

it("says it is looking while loading", () => {
  expect(labels(null).join("\n")).toContain("Looking for simulators");
});

it("shows the empty text and both problems when no tool is found", () => {
  const all = labels({ ios: null, android: null, problems: ["targets.sim.noXcode", "targets.sim.noAndroid"] }).join(" | ");
  expect(all).toContain("No simulators found.");
  expect(all).toContain("Xcode command line tools were not found.");
  expect(all).toContain("The Android emulator was not found.");
});

it("off macOS the empty text does not mention Xcode", () => {
  const all = labels({ ios: null, android: [], problems: [] }).join("\n");
  expect(all).toContain("No emulators found.");
  expect(all).not.toContain("Xcode");
});

it("lists rows with their state and action, and a row starts its device", () => {
  const onPick = vi.fn();
  const list: SimList = {
    ios: [
      { platform: "ios", id: "a", name: "iPhone 16", runtime: "iOS 18.0", state: "booted", serial: null },
      { platform: "ios", id: "b", name: "iPhone 15", runtime: "iOS 17.5", state: "shutdown", serial: null },
    ],
    android: [],
    problems: [],
  };
  const all = labels(list, onPick).join("\n");
  expect(all).toContain("iPhone 16 · iOS 18.0 · Running · Stream logs");
  expect(all).toContain("iPhone 15 · iOS 17.5 · Not running · Start and stream logs");
  expect(all).not.toContain("No simulators found.");
  expect(all).not.toContain("Android emulators");
  const row = simEntries(list, t, onPick).find((e) => "label" in e && e.label.startsWith("iPhone 15")) as { onSelect(): void };
  row.onSelect();
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
});
