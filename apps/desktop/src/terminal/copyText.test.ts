import { describe, expect, it } from "vitest";
import { trimGutter } from "./copyText";

describe("trimGutter", () => {
  it("drops trailing blanks per line and keeps CRLF", () => {
    expect(trimGutter("a  \r\nb\t\r\n")).toBe("a\r\nb\r\n");
  });
  it("cuts a box border", () => {
    expect(trimGutter("│ a │\n│ b │\n│ c │")).toBe("a\nb\nc");
  });
  it("cuts a line-number gutter", () => {
    expect(trimGutter("  9 │ x\n 10 │ y")).toBe("x\ny");
  });
  it("keeps borders when a line has none", () => {
    expect(trimGutter("│ a │\nplain\n│ c │")).toBe("│ a │\nplain\n│ c │");
  });
  it("never cuts one line", () => {
    expect(trimGutter("ls | wc -l")).toBe("ls | wc -l");
    expect(trimGutter("")).toBe("");
  });
});
