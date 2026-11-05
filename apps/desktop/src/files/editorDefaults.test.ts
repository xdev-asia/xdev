import { describe, expect, it } from "vitest";
import { EDITOR_DEFAULTS } from "./editorDefaults";

describe("EDITOR_DEFAULTS", () => {
  it("wraps by default", () => {
    expect(EDITOR_DEFAULTS.wordWrap).toBe(true);
  });
  it("follows the terminal font by default", () => {
    expect(EDITOR_DEFAULTS.fontFamily).toBe("");
  });
});
