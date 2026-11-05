import { expect, it } from "vitest";
import { splitShellWords } from "./shellWords";

const words = (t: string) => splitShellWords(t).words;

it("splits on whitespace and drops empty runs", () => {
  expect(words("  --a   b\t--c=d \n")).toEqual(["--a", "b", "--c=d"]);
  expect(words("")).toEqual([]);
});

it("keeps quoted text as one word, empty quotes as an empty word", () => {
  expect(words(`--add-dir "my dir" 'it is'`)).toEqual(["--add-dir", "my dir", "it is"]);
  expect(words(`a "" b`)).toEqual(["a", "", "b"]);
  expect(words(`pre"fix ed"post`)).toEqual(["prefix edpost"]);
});

it("reads backslashes like a shell", () => {
  expect(words(String.raw`a\ b c`)).toEqual(["a b", "c"]);
  expect(words(String.raw`"a \"q\" \\ \n"`)).toEqual([String.raw`a "q" \ \n`]);
  expect(words(String.raw`'a\b'`)).toEqual([String.raw`a\b`]);
});

it("reports an open quote or a trailing backslash", () => {
  expect(splitShellWords(`a "b`).error).toBe("unterminated");
  expect(splitShellWords(`a 'b`).error).toBe("unterminated");
  expect(splitShellWords("a \\").error).toBe("unterminated");
  expect(splitShellWords("a b").error).toBeNull();
});

it("does not expand anything", () => {
  expect(words("$HOME `x` *.ts")).toEqual(["$HOME", "`x`", "*.ts"]);
});
