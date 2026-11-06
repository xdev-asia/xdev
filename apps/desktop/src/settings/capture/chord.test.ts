import { describe, expect, it } from "vitest";
import { acceleratorLabel, DEFAULT_CAPTURE_SHORTCUT, toAccelerator } from "./chord";

describe("capture shortcut chords", () => {
  it("the main modifier becomes CmdOrCtrl", () => {
    expect(toAccelerator("Ctrl+Alt+Shift+S", "win")).toBe(DEFAULT_CAPTURE_SHORTCUT);
    expect(toAccelerator("Ctrl+Alt+Shift+S", "linux")).toBe(DEFAULT_CAPTURE_SHORTCUT);
    expect(toAccelerator("Alt+Shift+Cmd+S", "mac")).toBe(DEFAULT_CAPTURE_SHORTCUT);
    // Control on macOS is not the main modifier.
    expect(toAccelerator("Ctrl+Shift+4", "mac")).toBe("Ctrl+Shift+4");
    expect(toAccelerator("Ctrl+Cmd+F5", "mac")).toBe("CmdOrCtrl+Ctrl+F5");
  });

  it("labels the platform's names", () => {
    expect(acceleratorLabel(DEFAULT_CAPTURE_SHORTCUT, "win")).toBe("Ctrl+Alt+Shift+S");
    expect(acceleratorLabel(DEFAULT_CAPTURE_SHORTCUT, "mac")).toBe("⌥⇧⌘S");
    expect(acceleratorLabel("Ctrl+Shift+4", "mac")).toBe("⌃⇧4");
  });
});
