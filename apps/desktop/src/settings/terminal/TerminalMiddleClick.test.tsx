import { expect, it, vi } from "vitest";
import { mount } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { TERMINAL_DEFAULTS } from "@/terminal/terminalSettings";
import { runSearch } from "../searchModel";
import { TerminalBehaviourSection } from "./TerminalBehaviourSection";

const os = vi.hoisted(() => ({ platform: "linux" as "linux" | "win" }));
vi.mock("@/platform", async (original) => ({
  ...(await original<typeof import("@/platform")>()),
  get PLATFORM() {
    return os.platform;
  },
}));
vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const label = translate("en", "settings.terminal.interaction.middleClickPaste");
const switchOf = (m: { all(): { props: Record<string, any> }[] }) => m.all().find((n) => n.props["aria-label"] === label);

function open(patch = vi.fn(), current = TERMINAL_DEFAULTS) {
  return { patch, m: mount(TerminalBehaviourSection, () => ({ current, busy: false, patch, filter: undefined })) };
}

it("shows the switch on Linux, off by default, and puts only its field", () => {
  os.platform = "linux";
  const { m, patch } = open();
  expect(switchOf(m)!.props["aria-checked"]).toBe(false);
  switchOf(m)!.props.onClick();
  expect(patch).toHaveBeenCalledWith({ middleClickPaste: true });
});

it("reflects a stored value", () => {
  os.platform = "linux";
  const { m } = open(vi.fn(), { ...TERMINAL_DEFAULTS, middleClickPaste: true });
  expect(switchOf(m)!.props["aria-checked"]).toBe(true);
});

it("is hidden on other platforms", () => {
  os.platform = "win";
  expect(switchOf(open().m)).toBeUndefined();
});

it("is a Linux-only catalogue entry", () => {
  const t = (key: string) => translate("en", key);
  const hit = (platform: "linux" | "win") => {
    os.platform = platform;
    return runSearch("paste on middle", t, (id) => id).ids.has("terminal.middleClickPaste");
  };
  expect(hit("linux")).toBe(true);
  expect(hit("win")).toBe(false);
});
