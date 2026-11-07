import { expect, it, vi } from "vitest";
import type { JSX } from "react";
import type { TerminalHostInfo } from "@/api";
import { translate } from "@/i18n";
import { mount, tick } from "@/kit/testHooks";
import { TERMINAL_DEFAULTS } from "@/terminal/terminalSettings";
import type { TerminalSectionProps } from "./sectionProps";
import { POWERSHELL_URL, TerminalAdvancedSection } from "./TerminalAdvancedSection";

const os = vi.hoisted(() => ({ platform: "win" as "win" | "linux" }));
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

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const HOST: TerminalHostInfo = { ptyLimit: 4096, pwshFound: true, defaultIsPowershell: true };

function open(host: () => Promise<TerminalHostInfo>, platform: "win" | "linux" = "win") {
  os.platform = platform;
  const patch = vi.fn(async () => {});
  const api = { terminalHostInfo: vi.fn(host), openUrl: vi.fn(async () => {}) };
  const component = TerminalAdvancedSection as (props: Parameters<typeof TerminalAdvancedSection>[0]) => JSX.Element;
  const m = mount(component, () => ({ api, current: TERMINAL_DEFAULTS, busy: false, patch, filter: undefined }) as Omit<TerminalSectionProps, "api"> & { api: typeof api });
  return { m, api, patch };
}
const field = (m: { all(): { props: Record<string, any> }[] }, name: string) => m.all().find((n) => n.props["data-field"] === name);
const radios = (m: { all(): { props: Record<string, any> }[] }) => m.all().find((n) => n.props.name === "terminal-windows-powershell");
const text = (m: { all(): { props: Record<string, any> }[] }) => JSON.stringify(m.all().map((n) => n.props.children));

it("shows the system PTY limit and puts a typed maximum, clamped to at least 1", async () => {
  const { m, patch } = open(async () => HOST);
  await m.settle();
  expect(text(m)).toContain(en("settings.terminal.advanced.ptyLimit", { value: 4096 }));
  field(m, "maxRunningTerminals")!.props.onChange({ target: { value: "300" } });
  field(m, "maxRunningTerminals")!.props.onKeyDown({ key: "Enter" });
  expect(patch).toHaveBeenLastCalledWith({ maxRunningTerminals: 300 });
  field(m, "maxRunningTerminals")!.props.onChange({ target: { value: "0" } });
  field(m, "maxRunningTerminals")!.props.onBlur();
  expect(patch).toHaveBeenLastCalledWith({ maxRunningTerminals: 1 });
});

it("a value above the system limit is cut to it", async () => {
  const { m, patch } = open(async () => ({ ...HOST, ptyLimit: 128 }));
  await m.settle();
  field(m, "maxRunningTerminals")!.props.onChange({ target: { value: "500" } });
  field(m, "maxRunningTerminals")!.props.onBlur();
  expect(patch).toHaveBeenLastCalledWith({ maxRunningTerminals: 128 });
});

it("a failed host read shows the error and Retry reads again; the field still works", async () => {
  const { m, api, patch } = open(async () => {
    throw new Error("x");
  });
  await m.settle();
  expect(text(m)).toContain(en("settings.terminal.advanced.hostInfoFailed"));
  expect(api.terminalHostInfo).toHaveBeenCalledTimes(1);
  field(m, "host-info-retry")!.props.onClick();
  await tick();
  expect(api.terminalHostInfo).toHaveBeenCalledTimes(2);
  field(m, "maxRunningTerminals")!.props.onChange({ target: { value: "2000" } });
  field(m, "maxRunningTerminals")!.props.onBlur();
  expect(patch).toHaveBeenLastCalledWith({ maxRunningTerminals: 1024 });
});

it("the PowerShell row is hidden off Windows and when the default shell is not PowerShell", async () => {
  const linux = open(async () => HOST, "linux");
  await linux.m.settle();
  expect(radios(linux.m)).toBeUndefined();
  const other = open(async () => ({ ...HOST, defaultIsPowershell: false }));
  await other.m.settle();
  expect(radios(other.m)).toBeUndefined();
  const win = open(async () => HOST);
  await win.m.settle();
  expect(radios(win.m)).toBeDefined();
});

it("PowerShell 7+ is a disabled option with a hint when it is not installed; the others still put their value", async () => {
  const { m, patch, api } = open(async () => ({ ...HOST, pwshFound: false }));
  await m.settle();
  const options = radios(m)!.props.options as { value: string; disabled?: boolean; hint?: string }[];
  expect(options.map((o) => o.value)).toEqual(["auto", "windows", "pwsh"]);
  expect(options.map((o) => !!o.disabled)).toEqual([false, false, true]);
  expect(options[2]!.hint).toBe(en("settings.terminal.advanced.powershellMissing"));
  radios(m)!.props.onChange("windows");
  expect(patch).toHaveBeenLastCalledWith({ windowsPowershell: "windows" });
  field(m, "powershell-download")!.props.onClick();
  expect(api.openUrl).toHaveBeenCalledWith(POWERSHELL_URL);
  expect(POWERSHELL_URL.startsWith("https://")).toBe(true);
});

it("with PowerShell 7+ installed its option is enabled and there is no download button", async () => {
  const { m } = open(async () => HOST);
  await m.settle();
  const options = radios(m)!.props.options as { disabled?: boolean }[];
  expect(options.some((o) => o.disabled)).toBe(false);
  expect(field(m, "powershell-download")).toBeUndefined();
});
