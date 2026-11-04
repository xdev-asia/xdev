import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { SchemePreview } from "@/api";
import { translate } from "@/i18n";
import { TERMINAL_SCHEMES } from "@/terminal/terminalThemes";
import { ANSI_KEYS } from "./ansiKeys";
import { ImportSchemeDialog } from "./ImportSchemeDialog";

// Called as plain functions, so the hooks are stubbed out.
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useRef: () => ({ current: null }), useEffect: () => {} }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

const preview = (over: Partial<SchemePreview> = {}): SchemePreview => ({
  scheme: { id: "custom-mine", name: "Mine", mode: "dark", colors: TERMINAL_SCHEMES[0]!.colors },
  ignoredKeys: [],
  lowContrast: false,
  nameTaken: false,
  ...over,
});

function dialog(over: Partial<Parameters<typeof ImportSchemeDialog>[0]> = {}) {
  const props = { open: true, preview: preview(), busy: false, onImport: vi.fn(), onCancel: vi.fn(), ...over };
  const tree = ImportSchemeDialog(props);
  return { props, html: renderToStaticMarkup(tree), nodes: nodes(tree) };
}
const byAction = (d: ReturnType<typeof dialog>, action: string) => d.nodes.find((n) => n.props["data-action"] === action);
const primaries = (d: ReturnType<typeof dialog>) => d.nodes.filter((n) => n.props["data-action"] && n.props.variant !== "secondary").map((n) => n.props["data-action"]);

it("previews the name and the 16 colours", () => {
  const d = dialog();
  expect(d.html).toContain("Mine");
  const swatches = d.nodes.filter((n) => n.props["data-swatch"]);
  expect(swatches.map((n) => n.props["data-swatch"])).toEqual([...ANSI_KEYS]);
  expect(swatches.map((n) => n.props.style.background)).toEqual(ANSI_KEYS.map((k) => TERMINAL_SCHEMES[0]!.colors[k]));
});

it("warns on low contrast and lists ignored keys, and only then", () => {
  expect(dialog().html).not.toContain(en("settings.terminal.import.lowContrast"));
  const d = dialog({ preview: preview({ lowContrast: true, ignoredKeys: ["ansi", "extra"] }) });
  expect(d.html).toContain(en("settings.terminal.import.lowContrast"));
  expect(d.html).toContain(en("settings.terminal.import.ignored", { keys: "ansi, extra" }));
});

it("a new name offers Import and Cancel; Import is the one primary button", () => {
  const d = dialog();
  expect(byAction(d, "replace")).toBeUndefined();
  byAction(d, "import")!.props.onClick();
  expect(d.props.onImport).toHaveBeenCalledWith("fail");
  byAction(d, "cancel")!.props.onClick();
  expect(d.props.onCancel).toHaveBeenCalled();
  expect(primaries(d)).toEqual(["import"]);
});

it("a name clash asks Replace / Keep both / Cancel, with Keep both as the primary", () => {
  const d = dialog({ preview: preview({ nameTaken: true }) });
  expect(d.html).toContain(en("settings.terminal.import.taken", { name: "Mine" }));
  expect(byAction(d, "import")).toBeUndefined();
  byAction(d, "replace")!.props.onClick();
  byAction(d, "keepBoth")!.props.onClick();
  expect(vi.mocked(d.props.onImport).mock.calls).toEqual([["replace"], ["keepBoth"]]);
  expect(byAction(d, "cancel")).toBeDefined();
  expect(primaries(d)).toEqual(["keepBoth"]);
});

it("shows an error through error.<code>, with the field for theme_invalid, and offers no import without a preview", () => {
  const d = dialog({ preview: null, error: { code: "theme_invalid", detail: "foreground" } });
  expect(d.html).toContain(en("error.theme_invalid"));
  expect(d.html).toContain("foreground");
  expect(byAction(d, "import")).toBeUndefined();
  expect(byAction(d, "cancel")).toBeDefined();
  expect(dialog({ preview: null, error: { code: "theme_too_large" } }).html).toContain(en("error.theme_too_large"));
});

it("keeps the choices off while busy", () => {
  const d = dialog({ busy: true, preview: preview({ nameTaken: true }) });
  for (const a of ["replace", "keepBoth", "cancel"]) expect(byAction(d, a)!.props.disabled).toBe(true);
});
