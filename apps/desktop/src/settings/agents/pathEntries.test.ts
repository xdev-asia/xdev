import { expect, it } from "vitest";
import { cleanEntries, layoutPath, separatorFor, validateEntry } from "./pathEntries";

it("refuses empty entries, the separator and control characters", () => {
  expect(validateEntry("   ", ":")).toEqual({ problem: "empty" });
  expect(validateEntry("/a:/b", ":")).toEqual({ problem: "separator" });
  expect(validateEntry("C:\\a;C:\\b", ";")).toEqual({ problem: "separator" });
  expect(validateEntry("/a\u0007b", ":")).toEqual({ problem: "control" });
  expect(validateEntry("  /opt/bin ", ":")).toEqual({ ok: "/opt/bin" });
  expect(validateEntry("C:\\tools", separatorFor(false))).toEqual({ problem: "separator" });
});

it("cleans entries to valid, trimmed and unique ones", () => {
  expect(cleanEntries([" /a ", "", "/a", "/b:/c", "/d"], ":")).toEqual(["/a", "/d"]);
  expect(cleanEntries(["C:\\A", "c:\\a"], ";")).toEqual(["C:\\A"]);
});

it("lays out prepend, system, then append, each directory once, and flags missing ones", () => {
  const out = layoutPath(["/bin", "/gone"], ["/mine", "/bin"], ["/late", "/gone"], (p) => p !== "/gone");
  expect(out.map((e) => [e.path, e.source, e.exists])).toEqual([
    ["/mine", "prepend", true],
    ["/bin", "prepend", true],
    ["/gone", "system", false],
    ["/late", "append", true],
  ]);
});
