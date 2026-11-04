import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AwakeView } from "@/api";
import { translate } from "@/i18n";
import { KeepAwakeView } from "./KeepAwakeItem";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const noop = () => {};
const render = (view: AwakeView, open: boolean) => renderToStaticMarkup(<KeepAwakeView view={view} open={open} onToggle={noop} onClose={noop} onPick={noop} />);

it("shows the mode on the footer button, closed", () => {
  const html = render({ mode: "agent", held: false, supported: true }, false);
  expect(html).toContain(en("keepAwake.item", { mode: en("keepAwake.mode.agent") }));
  expect(html).toContain('data-action="keep-awake"');
  expect(html).not.toContain("radiogroup");
});

it("shows a dot while the request is held", () => {
  expect(render({ mode: "on", held: true, supported: true }, false)).toContain('data-dot="working"');
  expect(render({ mode: "on", held: false, supported: true }, false)).not.toContain('data-dot="working"');
});

it("open: one radio per mode with the current one checked", () => {
  const html = render({ mode: "agent", held: false, supported: true }, true);
  expect(html).toContain("radiogroup");
  expect(html.match(/type="radio"/g)).toHaveLength(3);
  expect(html).toMatch(/value="agent"[^>]*checked|checked[^>]*value="agent"/);
  for (const mode of ["off", "agent", "on"]) expect(html).toContain(en(`keepAwake.hint.${mode}`));
});

it("open on a machine without a way to stay awake: says so and keeps the choices, so Off stays reachable", () => {
  const html = render({ mode: "off", held: false, supported: false }, true);
  expect(html).toContain(en("keepAwake.unsupported"));
  expect(html.match(/type="radio"/g)).toHaveLength(3);
});
