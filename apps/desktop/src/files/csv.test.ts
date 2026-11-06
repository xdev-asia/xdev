import { describe, expect, it } from "vitest";
import { ROW_CAP, delimiterOf, findCells, parseDelimited, toGrid } from "./csv";

describe("parseDelimited", () => {
  const table: Array<[string, string, string[][]]> = [
    ["plain", "a,b\n1,2", [["a", "b"], ["1", "2"]]],
    ["CRLF", "a,b\r\n1,2\r\n", [["a", "b"], ["1", "2"]]],
    ["lone CR", "a,b\r1,2", [["a", "b"], ["1", "2"]]],
    ["trailing newline adds no row", "a\n", [["a"]]],
    ["quoted comma", 'a,"b,c",d', [["a", "b,c", "d"]]],
    ["quoted newline", 'a,"line1\nline2"\nx,y', [["a", "line1\nline2"], ["x", "y"]]],
    ["quoted CRLF", 'a,"l1\r\nl2"\r\nb,c', [["a", "l1\r\nl2"], ["b", "c"]]],
    ["escaped quote", '"say ""hi""",x', [['say "hi"', "x"]]],
    ["empty fields", "a,,c\n,,", [["a", "", "c"], ["", "", ""]]],
    ["empty quoted field", '"",a', [["", "a"]]],
    ["quote inside unquoted field is literal", 'ab"c,d', [['ab"c', "d"]]],
    ["BOM dropped", "﻿a,b", [["a", "b"]]],
    ["blank line is a row", "a\n\nb", [["a"], [""], ["b"]]],
    ["unterminated quote keeps the rest", 'a,"b\nc', [["a", "b\nc"]]],
    ["empty input", "", []],
  ];
  for (const [name, input, want] of table) it(name, () => expect(parseDelimited(input)).toEqual(want));

  it("splits on tabs for TSV and leaves commas alone", () => {
    expect(parseDelimited("a,b\tc\n1\t2", "\t")).toEqual([["a,b", "c"], ["1", "2"]]);
  });
});

describe("delimiterOf", () => {
  it("is a tab for tsv and a comma for csv", () => {
    expect(delimiterOf("x/a.TSV")).toBe("\t");
    expect(delimiterOf("a.csv")).toBe(",");
  });
});

describe("toGrid", () => {
  it("takes the first row as header and pads short rows", () => {
    const g = toGrid([["a", "b", "c"], ["1"], ["1", "2", "3", "4"]]);
    expect(g.columns).toBe(4);
    expect(g.header).toEqual(["a", "b", "c", ""]);
    expect(g.rows).toEqual([["1", "", "", ""], ["1", "2", "3", "4"]]);
    expect(g.hidden).toBe(0);
  });

  it("shows the first ROW_CAP data rows and counts the rest", () => {
    const parsed = [["h"], ...Array.from({ length: ROW_CAP + 7 }, (_, i) => [String(i)])];
    const g = toGrid(parsed);
    expect(g.rows).toHaveLength(ROW_CAP);
    expect(g.hidden).toBe(7);
    expect(g.rows[0]).toEqual(["0"]);
  });

  it("has no columns for no rows", () => {
    expect(toGrid([]).columns).toBe(0);
  });
});

describe("findCells", () => {
  const g = toGrid(parseDelimited("Name,City\nAnn,Hanoi\nBob,hanoi\nCy,Hue"));
  it("matches ignoring case, header first, in reading order", () => {
    expect(findCells(g, "HANOI")).toEqual([{ row: 0, col: 1 }, { row: 1, col: 1 }]);
    expect(findCells(g, "name")).toEqual([{ row: -1, col: 0 }]);
  });
  it("matches nothing for an empty query or a miss", () => {
    expect(findCells(g, "")).toEqual([]);
    expect(findCells(g, "zzz")).toEqual([]);
  });
});
