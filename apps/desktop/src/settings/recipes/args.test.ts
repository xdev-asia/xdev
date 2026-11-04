import { describe, expect, it } from "vitest";
import { joinArgs, splitArgs } from "./args";

describe("splitArgs", () => {
  it("splits on spaces", () => {
    expect(splitArgs("--model  gpt-5 -c x=1")).toEqual(["--model", "gpt-5", "-c", "x=1"]);
    expect(splitArgs("  ")).toEqual([]);
    expect(splitArgs("")).toEqual([]);
  });

  it("keeps quoted text together", () => {
    expect(splitArgs(`--append "be brief, please" 'it is'`)).toEqual(["--append", "be brief, please", "it is"]);
    expect(splitArgs(`a "" b`)).toEqual(["a", "", "b"]);
    expect(splitArgs(`x="a b"`)).toEqual(["x=a b"]);
  });

  it("lets a backslash escape a quote or a space", () => {
    expect(splitArgs(String.raw`"say \"hi\"" a\ b`)).toEqual([`say "hi"`, "a b"]);
  });

  it("reads an unclosed quote to the end", () => {
    expect(splitArgs(`--x "a b`)).toEqual(["--x", "a b"]);
  });
});

describe("joinArgs", () => {
  it("round-trips", () => {
    for (const args of [["--a", "b c", ""], ['say "hi"', "a\\b"], [], ["x=1"]]) {
      expect(splitArgs(joinArgs(args))).toEqual(args);
    }
    expect(joinArgs(["-m", "a b"])).toBe('-m "a b"');
  });
});
