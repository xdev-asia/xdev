import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { TermConfigPreview, TerminalSettings } from "@/api";
import { translate } from "@/i18n";
import { TERMINAL_SCHEMES } from "@/terminal/terminalThemes";
import { configChange, configRows } from "./importConfig";
import { ImportConfigDialog } from "./ImportConfigDialog";

vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useRef: () => ({ current: null }), useEffect: () => {} }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

const current = { fontFamily: "", fontSize: 13, cursorStyle: "block", cursorBlink: true, scrollback: 10000, paddingPx: 8, backgroundOpacity: 1, theme: "app" } as TerminalSettings;
const preview = (over: Partial<TermConfigPreview> = {}): TermConfigPreview => ({
  kind: "kitty",
  path: "/home/u/kitty.conf",
  fontFamily: "Fira Code",
  fontSize: 13,
  cursorStyle: "bar",
  cursorBlink: null,
  scrollback: null,
  paddingPx: null,
  backgroundOpacity: null,
  themeName: null,
  scheme: { id: "custom-kitty-import", name: "Kitty import", mode: "dark", colors: TERMINAL_SCHEMES[0]!.colors },
  ...over,
});

it("lists only the settings that change, with the colours last", () => {
  const rows = configRows(current, preview(), null);
  expect(rows.map((r) => r.id)).toEqual(["fontFamily", "cursorStyle", "colors"]);
  expect(rows[0]).toEqual({ id: "fontFamily", from: null, to: "Fira Code" });
});

it("applies only the checked rows and says when the scheme is to be saved", () => {
  const p = preview();
  expect(configChange(p, new Set(["fontFamily"]))).toEqual({ change: { fontFamily: "Fira Code" }, saveScheme: false });
  const all = configChange(p, new Set(["cursorStyle", "colors"]));
  expect(all).toEqual({ change: { cursorStyle: "bar" }, saveScheme: true });
});

function dialog(over: Partial<Parameters<typeof ImportConfigDialog>[0]> = {}) {
  const p = preview();
  const props = {
    open: true, detected: { ghostty: null, kitty: "/home/u/kitty.conf" }, kind: "kitty" as const, preview: p,
    rows: configRows(current, p, null), checked: new Set(["fontFamily" as const]), busy: false,
    onPick: vi.fn(), onChooseFile: vi.fn(), onToggle: vi.fn(), onApply: vi.fn(), onCancel: vi.fn(), ...over,
  };
  const tree = ImportConfigDialog(props);
  return { props, html: renderToStaticMarkup(tree), nodes: nodes(tree) };
}
const action = (d: ReturnType<typeof dialog>, a: string) => d.nodes.find((n) => n.props["data-action"] === a);

it("enables only detected configs, always allows a file, and has one primary button", () => {
  const d = dialog();
  expect(action(d, "pick-ghostty")!.props.disabled).toBe(true);
  expect(action(d, "pick-kitty")!.props.disabled).toBe(false);
  expect(action(d, "file-ghostty")!.props.disabled).toBe(false);
  action(d, "pick-kitty")!.props.onClick();
  expect(d.props.onPick).toHaveBeenCalledWith("kitty");
  const primaries = d.nodes.filter((n) => n.props["data-action"] && n.props.variant !== "secondary");
  expect(primaries.map((n) => n.props["data-action"])).toEqual(["apply"]);
  action(d, "apply")!.props.onClick();
  expect(d.props.onApply).toHaveBeenCalled();
});

it("shows a row per change with its checkbox, and no Apply when nothing is ticked or nothing changes", () => {
  const d = dialog();
  expect(d.nodes.filter((n) => n.props["data-check"]).map((n) => [n.props["data-check"], n.props.checked])).toEqual([["fontFamily", true], ["cursorStyle", false], ["colors", false]]);
  expect(action(dialog({ checked: new Set() }), "apply")!.props.disabled).toBe(true);
  const none = dialog({ rows: [] });
  expect(action(none, "apply")).toBeUndefined();
  expect(none.html).toContain(translate("en", "settings.terminal.importConfig.nothing"));
});
