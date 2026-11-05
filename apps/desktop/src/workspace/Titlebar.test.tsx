import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButton } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { getTitlebar, resetTitlebarForTests, setTitlebar } from "@/ui/titlebar";
import { Titlebar } from "./Titlebar";
import type { WindowControls } from "./windowControls";

// Called directly, outside a render: state lives in a slot, effects do not run, the store is read plainly.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = initial;
      return [hooks.values[index], (v: unknown) => void (hooks.values[index] = v)];
    },
    useEffect: () => {},
  };
});
vi.mock("@/ui/titlebar", async (original) => {
  const real = await original<typeof import("@/ui/titlebar")>();
  return { ...real, useTitlebar: () => real.getTitlebar() };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale: vi.fn(), t: (key: string) => translate("en", key) }) }));

const en = (key: string) => translate("en", key);
type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

function controls(): WindowControls {
  return {
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
  };
}

const draw = (platform: "win" | "mac" | "linux", c = controls()) => {
  hooks.cursor = 0;
  return nodes(Titlebar({ platform, controls: c }));
};

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  resetTitlebarForTests();
});

it("draws nothing while the title bar is native", () => {
  expect(draw("win")).toEqual([]);
  expect(draw("mac")).toEqual([]);
});

it("is a drag region with the app name when custom", () => {
  setTitlebar({ titlebar: "custom", showTitlebarName: true });
  const root = draw("win")[0]!;
  expect(root.props.className).toBe("ws-titlebar");
  expect(root.props["data-tauri-drag-region"]).toBeDefined();
  const html = renderToStaticMarkup(<Titlebar platform="win" controls={controls()} />);
  expect(html).toContain("data-tauri-drag-region");
  expect(html).toContain(en("titlebar.appName"));
  expect(html).toContain(`aria-label="${en("titlebar.close")}"`);
});

it("hides the app name when the setting is off", () => {
  setTitlebar({ titlebar: "custom", showTitlebarName: false });
  expect(nodes(Titlebar({ platform: "win", controls: controls() })).some((n) => n.props.className === "ws-titlebar-name")).toBe(false);
  setTitlebar({ titlebar: "custom", showTitlebarName: true });
  const name = draw("win").find((n) => n.props.className === "ws-titlebar-name")!;
  expect(name.props.children).toBe(en("titlebar.appName"));
});

it("leaves the traffic lights alone on macOS: an inset, no buttons", () => {
  setTitlebar({ titlebar: "custom", showTitlebarName: true });
  const all = draw("mac");
  expect(all[0]!.props["data-platform"]).toBe("mac");
  expect(all.some((n) => n.type === IconButton)).toBe(false);
});

it.each(["win", "linux"] as const)("has minimize, maximize and close on %s that call the window", (platform) => {
  setTitlebar({ titlebar: "custom", showTitlebarName: true });
  const c = controls();
  const buttons = draw(platform, c).filter((n) => n.type === IconButton);
  expect(buttons.map((b) => b.props.label)).toEqual([en("titlebar.minimize"), en("titlebar.maximize"), en("titlebar.close")]);
  buttons.forEach((b) => b.props.onClick());
  expect(c.minimize).toHaveBeenCalledTimes(1);
  expect(c.toggleMaximize).toHaveBeenCalledTimes(1);
  expect(c.close).toHaveBeenCalledTimes(1);
});

it("the store keeps the last applied setting", () => {
  setTitlebar({ titlebar: "custom", showTitlebarName: false });
  expect(getTitlebar()).toEqual({ mode: "custom", showName: false });
  setTitlebar({});
  expect(getTitlebar()).toEqual({ mode: "native", showName: true });
});
