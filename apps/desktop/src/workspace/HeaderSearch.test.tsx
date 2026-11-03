import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "../i18n";
import { HeaderSearch } from "./HeaderSearch";

// The effect is captured, not run by the renderer, so the test can run it against its own window.
const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => void hooks.effects.push(effect),
}));
vi.mock("../i18n", async (original) => ({ ...await original<typeof import("../i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

beforeEach(() => { hooks.effects = []; });
afterEach(() => { vi.unstubAllGlobals(); });

function key(win: EventTarget, init: { key: string; ctrlKey?: boolean }) {
  const event = Object.assign(new Event("keydown", { cancelable: true }), { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...init });
  win.dispatchEvent(event);
  return event;
}

it("shows the shortcut and opens on click", () => {
  const onOpen = vi.fn();
  const view = HeaderSearch({ onOpen }) as ReactElement<Record<string, any>>;
  expect(view.type).toBe("button");
  const html = renderToStaticMarkup(view);
  expect(html).toContain("Ctrl K");
  expect(html).toContain(translate("en", "workspace.header.search"));
  view.props.onClick();
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("opens on Ctrl+K anywhere", () => {
  const win = new EventTarget();
  vi.stubGlobal("window", win);
  const onOpen = vi.fn();
  HeaderSearch({ onOpen });
  const stop = hooks.effects.at(-1)!()!;

  key(win, { key: "k" });
  expect(onOpen).not.toHaveBeenCalled();
  const event = key(win, { key: "k", ctrlKey: true });
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(event.defaultPrevented).toBe(true);
  key(win, { key: "K", ctrlKey: true });
  expect(onOpen).toHaveBeenCalledTimes(2);

  // Unmounting stops listening.
  stop();
  key(win, { key: "k", ctrlKey: true });
  expect(onOpen).toHaveBeenCalledTimes(2);
});
