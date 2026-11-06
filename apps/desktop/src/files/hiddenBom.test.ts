import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { bomSet } from "./hiddenBom";

function hidden(doc: string): [number, number][] {
  const out: [number, number][] = [];
  bomSet(EditorState.create({ doc })).between(0, doc.length, (from, to) => void out.push([from, to]));
  return out;
}

it("a leading byte order mark is the one hidden range", () => {
  expect(hidden("﻿using System;")).toEqual([[0, 1]]);
});

it("a file without one, or with one further in, hides nothing", () => {
  expect(hidden("using System;")).toEqual([]);
  expect(hidden("a﻿b")).toEqual([]);
  expect(hidden("")).toEqual([]);
});
