import { expect, it } from "vitest";
import { translate } from "@/i18n";
import type { ShellLabels } from "@/api";
import { SHELL_LABEL_KEYS, shellLabels } from "./shellLabels";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

it("maps every ShellLabels field to a key that exists in en and vi", () => {
  const fields = Object.keys(shellLabels(en)).sort();
  expect(Object.keys(SHELL_LABEL_KEYS).sort()).toEqual(fields);
  for (const key of Object.values(SHELL_LABEL_KEYS)) {
    for (const locale of ["en", "vi"] as const) {
      expect(translate(locale, key), `${locale} ${key}`).not.toBe(key);
    }
  }
});

it("translates each field through the given function", () => {
  const labels: ShellLabels = shellLabels((key) => `<${key}>`);
  expect(labels.quit).toBe("<shell.menu.quit>");
  expect(labels.trayTooltip).toBe("<shell.tray.tooltip>");
  expect(labels.about).toBe("<shell.help.about>");
});
