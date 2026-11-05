import { describe, expect, it } from "vitest";
import { freeId } from "./agentForm";

describe("freeId", () => {
  it("never gives a reserved id", () => {
    expect(freeId("Auto", [], "custom")).toBe("auto-2");
    expect(freeId("Blank", [], "custom")).toBe("blank-2");
    expect(freeId("Shell", [], "custom")).toBe("shell-2");
    expect(freeId("Mine", ["mine"], "custom")).toBe("mine-2");
    expect(freeId("", [], "custom")).toBe("custom");
  });
});
