import { expect, it } from "vitest";
import { mergeOutput, stripAnsi } from "./mergeOutput";

const part = (title: string, text: string, agent = "Claude") => ({ title, agent, text });

it("heads each section with the tab title and agent, in the order given", () => {
  const m = mergeOutput([part("Fix login", "one\ntwo\n"), part("Docs", "three\n", "Codex")]);
  expect(m.text).toBe("=== Fix login (Claude) ===\none\ntwo\n\n=== Docs (Codex) ===\nthree");
  expect(m).toMatchObject({ cut: false, tabs: 2 });
});

it("strips ANSI sequences and control characters", () => {
  expect(stripAnsi("\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\r\nnext\u0008!")).toBe("red ok\nnext!");
  expect(mergeOutput([part("A", "\u001b[1mbold\u001b[0m")]).text).toBe("=== A (Claude) ===\nbold");
});

it("skips tabs with no output, and gives an empty document when none has any", () => {
  const m = mergeOutput([part("Empty", ""), part("Blank", " \n\n"), part("Real", "x"), part("Codes only", "\u001b[0m")]);
  expect(m.text).toBe("=== Real (Claude) ===\nx");
  expect(m.tabs).toBe(1);
  expect(mergeOutput([part("Empty", "")])).toEqual({ text: "", cut: false, tabs: 0 });
});

it("cuts at the byte cap on a line end and says so, leaving later tabs out", () => {
  const long = "a".repeat(10) + "\n" + "b".repeat(10) + "\n" + "c".repeat(10);
  const m = mergeOutput([part("A", long), part("B", "later")], 60);
  expect(m.cut).toBe(true);
  expect(new TextEncoder().encode(m.text).length).toBeLessThanOrEqual(60);
  expect(m.text.startsWith("=== A (Claude) ===\n")).toBe(true);
  expect(m.text).not.toContain("later");
  expect(m.text.endsWith("c".repeat(10))).toBe(true);
});

it("counts bytes, not characters, and never ends on half a character", () => {
  const m = mergeOutput([part("A", "é".repeat(100))], 40);
  expect(m.cut).toBe(true);
  expect(new TextEncoder().encode(m.text).length).toBeLessThanOrEqual(40);
  expect(m.text).not.toContain("�");
});

it("is not cut under the cap", () => {
  expect(mergeOutput([part("A", "short")], 1000).cut).toBe(false);
});
