import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SimList } from "@/api";
import { I18nProvider } from "@/i18n";
import { SimsItems } from "./SimsGroup";

const draw = (list: SimList | null) =>
  renderToStaticMarkup(
    <I18nProvider>
      <SimsItems list={list} onPick={vi.fn()} onRefresh={vi.fn()} />
    </I18nProvider>,
  );

it("says it is looking while loading", () => {
  expect(draw(null)).toContain("Looking for simulators");
});

it("shows the empty text and both problems when no tool is found", () => {
  const html = draw({ ios: null, android: null, problems: ["targets.sim.noXcode", "targets.sim.noAndroid"] });
  expect(html).toContain("No simulators found.");
  expect(html).toContain("Xcode command line tools were not found.");
  expect(html).toContain("The Android emulator was not found.");
  expect(html).toContain("Refresh");
});

it("off macOS the empty text does not mention Xcode", () => {
  const html = draw({ ios: null, android: [], problems: [] });
  expect(html).toContain("No emulators found.");
  expect(html).not.toContain("Xcode");
});

it("lists rows with their state and action", () => {
  const html = draw({
    ios: [
      { platform: "ios", id: "a", name: "iPhone 16", runtime: "iOS 18.0", state: "booted", serial: null },
      { platform: "ios", id: "b", name: "iPhone 15", runtime: "iOS 17.5", state: "shutdown", serial: null },
    ],
    android: [],
    problems: [],
  });
  expect(html).toContain("iPhone 16 · iOS 18.0 · Running");
  expect(html).toContain("iPhone 15 · iOS 17.5 · Not running");
  expect(html).toContain("Stream logs");
  expect(html).toContain("Start and stream logs");
  expect(html).not.toContain("No simulators found.");
  expect(html).not.toContain("Android emulators");
});
