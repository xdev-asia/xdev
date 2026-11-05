import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { clampTerminalSettings, resetTerminalSettingsForTests, setTerminalSettings, TERMINAL_DEFAULTS, TERMINAL_LIMITS } from "@/terminal/terminalSettings";
vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { PaneView } from "./PaneView";
import type { PaneLayout } from "./paneTree";

const layout: PaneLayout = {
  root: {
    kind: "split",
    id: "s1",
    dir: "right",
    sizes: [0.5, 0.5],
    children: [
      { kind: "leaf", id: "a", tabs: [], active: null },
      { kind: "leaf", id: "b", tabs: [], active: null },
    ],
  },
  focused: "a",
  expanded: null,
} as unknown as PaneLayout;

const render = () =>
  renderToStaticMarkup(<PaneView layout={layout} strip={() => null} onFocus={() => {}} onResize={() => {}} onEqualize={() => {}} />);

afterEach(() => resetTerminalSettingsForTests());

it("dims only the panes without focus, and only when the setting is on", () => {
  expect(render()).not.toContain("data-dim");
  setTerminalSettings({ ...TERMINAL_DEFAULTS, dimInactivePanes: true });
  const html = render();
  expect(html).toMatch(/data-pane="b"[^>]*data-dim="true"/);
  expect(html).not.toMatch(/data-pane="a"[^>]*data-dim/);
});

it("the divider thickness and padding stay inside their ranges", () => {
  const low = clampTerminalSettings({ ...TERMINAL_DEFAULTS, paneDividerPx: 0, paddingPx: -3, backgroundOpacity: 0.1 });
  expect(low).toMatchObject({ paneDividerPx: 1, paddingPx: 0, backgroundOpacity: 0.5 });
  const high = clampTerminalSettings({ ...TERMINAL_DEFAULTS, paneDividerPx: 9, paddingPx: 99, backgroundOpacity: 3 });
  expect(high).toMatchObject({ paneDividerPx: TERMINAL_LIMITS.paneDividerPx.max, paddingPx: 24, backgroundOpacity: 1 });
});
