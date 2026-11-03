import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetBindingsForTests, setKeybindingsText } from "./bindingsStore";
import { resetTerminalKeyForTests, setTerminalKeyHost, startDiagnosticToasts } from "./terminalKey";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  resetBindingsForTests();
  resetToastsForTests();
  resetTerminalKeyForTests();
});

function start() {
  const open = vi.fn();
  setTerminalKeyHost({ t: (k, v) => (v ? `${k} ${JSON.stringify(v)}` : k), openShortcuts: open });
  return { open, stop: startDiagnosticToasts() };
}

it("a file that is not JSON shows one toast, and the same text again shows no second", () => {
  const { open, stop } = start();
  setKeybindingsText("{ nope", "/p");
  expect(getToasts()).toHaveLength(1);
  expect(getToasts()[0].text).toContain("keys.fileError");
  getToasts()[0].actions[0].run();
  expect(open).toHaveBeenCalledWith();
  setKeybindingsText("{ nope", "/other");
  expect(getToasts()).toHaveLength(1);
  stop();
});

it("a collision shows a toast; a clean file and an unknown action show none", () => {
  const { stop } = start();
  setKeybindingsText('{ "version": 1, "keybindings": { "tab.new": ["Ctrl+W"] } }', "/p");
  // Ctrl+W is tab.close's default: the default loses, which is a conflict finding.
  expect(getToasts().map((t) => t.text).join()).toContain("keys.fileConflicts");
  resetToastsForTests();
  setKeybindingsText('{ "version": 1, "keybindings": { "no.such": ["Ctrl+Q"] } }', "/p");
  expect(getToasts()).toHaveLength(0);
  setKeybindingsText(null, "/p");
  expect(getToasts()).toHaveLength(0);
  stop();
});
