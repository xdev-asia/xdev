import { expect, it, vi } from "vitest";
import { mount } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { TERMINAL_DEFAULTS } from "@/terminal/terminalSettings";
import type { JSX } from "react";
import type { TerminalSectionProps } from "./sectionProps";
import { TerminalKeyboardSection } from "./TerminalKeyboardSection";

const os = vi.hoisted(() => ({ mac: true }));
vi.mock("@/platform", async (original) => ({
  ...(await original<typeof import("@/platform")>()),
  get IS_MAC() {
    return os.mac;
  },
}));
vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const label = translate("en", "settings.terminal.keyboard.jisYen");
const switchOf = (m: { all(): { props: Record<string, any> }[] }) => m.all().find((n) => n.props["aria-label"] === label);

function open(patch = vi.fn(), current = TERMINAL_DEFAULTS) {
  return { patch, m: mount(TerminalKeyboardSection as (props: TerminalSectionProps) => JSX.Element, () => ({ current, busy: false, patch, filter: undefined })) };
}

it("on macOS the JIS Yen switch is off by default and puts only its field", () => {
  os.mac = true;
  const { m, patch } = open();
  expect(switchOf(m)!.props["aria-checked"]).toBe(false);
  switchOf(m)!.props.onClick();
  expect(patch).toHaveBeenCalledWith({ macJisYenToBackslash: true });
});

it("reflects a stored value", () => {
  os.mac = true;
  expect(switchOf(open(vi.fn(), { ...TERMINAL_DEFAULTS, macJisYenToBackslash: true }).m)!.props["aria-checked"]).toBe(true);
});

it("the section is still absent off macOS", () => {
  os.mac = false;
  expect(switchOf(open().m)).toBeUndefined();
});
