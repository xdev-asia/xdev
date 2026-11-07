import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import { chordLabel } from "@/keys/keymap";

const st = vi.hoisted(() => ({ open: false, tabs: [] as { id: string }[] }));
const toggle = vi.hoisted(() => vi.fn());
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
vi.mock("./floatingStore", () => ({ useFloating: () => ({ open: st.open, tabs: st.tabs, active: null }), toggleFloating: toggle }));

import { FloatingItem } from "./FloatingItem";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const draw = () => FloatingItem() as ReactElement<Record<string, any>>;

beforeEach(() => {
  st.open = false;
  st.tabs = [];
  toggle.mockClear();
});

it("is a footer link button that says whether the panel is open", () => {
  const el = draw();
  expect(el.type).toBe("button");
  expect(el.props.className).toBe("ws-footer-link");
  expect(el.props["data-action"]).toBe("floating");
  expect(el.props.type).toBe("button");
  expect(el.props["aria-pressed"]).toBe(false);
  expect(el.props.children).toBe(en("floating.status"));
  st.open = true;
  expect(draw().props["aria-pressed"]).toBe(true);
});

it("its title has the chord, and a click toggles", () => {
  const el = draw();
  expect(el.props.title).toBe(en("floating.statusTitle", { keys: chordLabel("floating.toggle") as string }));
  el.props.onClick();
  expect(toggle).toHaveBeenCalledTimes(1);
});

it("shows the tab count when there are tabs, and keeps aria-pressed", () => {
  st.tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const el = draw();
  expect(el.props.children).toBe(en("floating.statusCount", { count: 3 }));
  expect(el.props["aria-pressed"]).toBe(false);
  st.open = true;
  expect(draw().props["aria-pressed"]).toBe(true);
  expect(draw().props.children).toBe("Floating (3)");
});
