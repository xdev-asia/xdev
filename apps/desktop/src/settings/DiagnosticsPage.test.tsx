import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { createMockCrash } from "@/mockCrash";
import { getToasts } from "@/workspace/toastStore";

vi.mock("@/i18n", async (orig) => {
  const real = await orig<typeof import("@/i18n")>();
  return { ...real, useI18n: () => ({ t: (k: string, v?: Record<string, string | number>) => real.translate("en", k, v) }) };
});

import { DiagnosticsPage, diagnosticsFileName, exportDiagnostics } from "./DiagnosticsPage";

const t = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
const render = (filter?: { query: string; ids: ReadonlySet<string> }) =>
  renderToStaticMarkup(createElement(DiagnosticsPage, { api: createMockCrash() as never, onChanged() {}, filter }));

beforeEach(() => {
  for (const x of [...getToasts()]) x.actions.length = 0;
});

it("has one primary button and three rows", () => {
  const html = render();
  expect(html.match(/data-setting-id="diagnostics\./g)).toHaveLength(3);
  expect(html.match(/class="btn"/g)).toHaveLength(1);
  expect(html.match(/btn-secondary/g)).toHaveLength(2);
});

it("a search hides the rows that are not hits", () => {
  const html = render({ query: "log", ids: new Set(["diagnostics.logs"]) });
  expect(html).toContain('data-setting-id="diagnostics.logs"');
  expect(html).not.toContain('data-setting-id="diagnostics.export"');
  expect(html).not.toContain('data-setting-id="diagnostics.crash"');
});

it("names the file after the day", () => {
  expect(diagnosticsFileName(new Date("2026-11-04T10:00:00Z"))).toBe("xdev-diagnostics-2026-11-04.json");
});

it("a cancelled save does nothing", async () => {
  const api = createMockCrash();
  const before = getToasts().length;
  await exportDiagnostics(api, async () => null, t);
  expect(api.__exports()).toEqual([]);
  expect(getToasts().length).toBe(before);
});

it("a saved export toasts with a reveal action", async () => {
  const api = createMockCrash();
  await exportDiagnostics(api, async () => "C:/tmp/d.json", t);
  expect(api.__exports()).toEqual(["C:/tmp/d.json"]);
  const toast = getToasts().at(-1)!;
  expect(toast.text).toContain("C:/tmp/d.json");
  toast.actions[0].run();
  expect(api.__logReveals()).toBe(1);
});

it("a failed export toasts the error", async () => {
  const api = createMockCrash();
  api.diagnosticsExport = async () => {
    throw new Error("disk full");
  };
  await exportDiagnostics(api, async () => "C:/tmp/d.json", t);
  expect(getToasts().at(-1)!.text).toBe(t("diagnostics.export.failed"));
});
