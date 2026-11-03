import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { HeaderSearch } from "./HeaderSearch";

vi.mock("@/keys/bindingsStore", async (original) => ({ ...await original<typeof import("@/keys/bindingsStore")>(), useBindings: () => ({}) }));
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));


it("shows the shortcut and opens on click", () => {
  const onOpen = vi.fn();
  const view = HeaderSearch({ onOpen }) as ReactElement<Record<string, any>>;
  expect(view.type).toBe("button");
  const html = renderToStaticMarkup(view);
  expect(html).toContain("Ctrl+K");
  expect(html).toContain(translate("en", "workspace.header.search"));
  view.props.onClick();
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("click calls onJump when set and shows Ctrl+J", () => {
  const onOpen = vi.fn();
  const onJump = vi.fn();
  const view = HeaderSearch({ onOpen, onJump }) as ReactElement<Record<string, any>>;
  expect(renderToStaticMarkup(view)).toContain("Ctrl+J");
  view.props.onClick();
  expect(onJump).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
});

it("takes the hint from the keymap, so a rebind shows", () => {
  expect(renderToStaticMarkup(HeaderSearch({ onOpen: vi.fn() }))).toContain("Ctrl+K");
});
