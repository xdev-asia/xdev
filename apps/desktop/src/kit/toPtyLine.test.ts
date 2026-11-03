import { describe, expect, it } from "vitest";
import { toPtyLine } from "./toPtyLine";

describe("toPtyLine", () => {
  it("joins lines with one space, whatever the line ending", () => {
    expect(toPtyLine("a\rb")).toBe("a b");
    expect(toPtyLine("a\nb")).toBe("a b");
    expect(toPtyLine("a\r\nb")).toBe("a b");
    expect(toPtyLine("a \r\n\r\n  b")).toBe("a b");
  });

  it("turns a tab into a space", () => {
    expect(toPtyLine("a\tb")).toBe("a b");
  });

  it("drops other control characters, so no escape sequence reaches the terminal", () => {
    expect(toPtyLine("x\u001b[2Jy")).toBe("x[2Jy");
    expect(toPtyLine("a\u0000b\u007fc\u0003d")).toBe("abcd");
  });

  it("never leaves a character that acts as Enter", () => {
    const seps = String.fromCharCode(0x0b, 0x0c, 0x85, 0x2028, 0x2029);
    const out = toPtyLine(`go${seps}now${seps}done`);
    expect(out).toBe("go now done");
  });

  it("trims the ends", () => {
    expect(toPtyLine("  \n hi \n ")).toBe("hi");
  });
});
