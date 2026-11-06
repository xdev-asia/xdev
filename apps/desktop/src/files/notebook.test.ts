import { describe, expect, it } from "vitest";
import { fenced, parseNotebook, stripAnsi } from "./notebook";

const nb = (cells: unknown[], metadata: unknown = {}) => JSON.stringify({ cells, metadata, nbformat: 4 });
const code = (outputs: unknown[], source: unknown = "x = 1") => ({ cell_type: "code", source, execution_count: 3, outputs });
const only = (outputs: unknown[]) => {
  const r = parseNotebook(nb([code(outputs)]));
  if (!r.ok) throw new Error("not ok");
  return r.notebook.cells[0]!.outputs;
};
const B64 = "iVBORw0KGgo=";

describe("parseNotebook", () => {
  it("reads cell kinds, joined line lists and the execution count", () => {
    const r = parseNotebook(nb([{ cell_type: "markdown", source: ["# T\n", "text"] }, code([], ["a\n", "b"]), { cell_type: "raw", source: "r" }]));
    expect(r.ok && r.notebook.cells.map((c) => [c.kind, c.source, c.count])).toEqual([["markdown", "# T\ntext", null], ["code", "a\nb", 3], ["raw", "r", null]]);
  });

  it("takes the language from language_info, then the kernel spec, else python", () => {
    const lang = (m: unknown) => {
      const r = parseNotebook(nb([], m));
      return r.ok ? r.notebook.language : null;
    };
    expect(lang({ language_info: { name: "Julia" } })).toBe("julia");
    expect(lang({ kernelspec: { language: "R" } })).toBe("r");
    expect(lang({})).toBe("python");
  });

  it("fails on bad JSON and on JSON that is not a notebook", () => {
    expect(parseNotebook("{nope")).toEqual({ ok: false, reason: "json" });
    expect(parseNotebook("[]")).toEqual({ ok: false, reason: "shape" });
    expect(parseNotebook('{"cells": 3}')).toEqual({ ok: false, reason: "shape" });
  });
});

describe("outputs", () => {
  it("stream keeps its name and loses ANSI", () => {
    expect(only([{ output_type: "stream", name: "stderr", text: ["\u001b[31mbad\u001b[0m\n"] }])).toEqual([{ kind: "text", text: "bad\n", stream: "stderr" }]);
    expect(only([{ output_type: "stream", name: "stdout", text: "hi" }])).toEqual([{ kind: "text", text: "hi", stream: "stdout" }]);
  });

  it("error shows the traceback with ANSI stripped", () => {
    const out = only([{ output_type: "error", ename: "ZeroDivisionError", evalue: "x", traceback: ["\u001b[0;31mZeroDivisionError\u001b[0m: x", "  line 1"] }]);
    expect(out).toEqual([{ kind: "error", name: "ZeroDivisionError", text: "ZeroDivisionError: x\n  line 1" }]);
  });

  it("error without a traceback falls back to name and value", () => {
    expect(only([{ output_type: "error", ename: "E", evalue: "v", traceback: [] }])).toEqual([{ kind: "error", name: "E", text: "E: v" }]);
  });

  it("png and jpeg become data URLs", () => {
    expect(only([{ output_type: "display_data", data: { "image/png": [B64.slice(0, 6), `${B64.slice(6)}\n`] } }])).toEqual([{ kind: "image", mime: "image/png", url: `data:image/png;base64,${B64}` }]);
    expect(only([{ output_type: "execute_result", data: { "image/jpeg": B64, "text/plain": "<Figure>" } }])).toEqual([{ kind: "image", mime: "image/jpeg", url: `data:image/jpeg;base64,${B64}` }]);
  });

  it("an image that is not base64 is not a data URL", () => {
    expect(only([{ output_type: "display_data", data: { "image/png": 'x" onerror="y', "text/plain": "fallback" } }])).toEqual([{ kind: "text", text: "fallback" }]);
  });

  it("text/plain wins over html", () => {
    expect(only([{ output_type: "execute_result", data: { "text/html": "<b>x</b>", "text/plain": "x" } }])).toEqual([{ kind: "text", text: "x" }]);
  });

  it("html alone is shown as text, never as markup", () => {
    expect(only([{ output_type: "display_data", data: { "text/html": ["<script>alert(1)</script>", "<b>x</b>"] } }])).toEqual([{ kind: "text", text: "<script>alert(1)</script><b>x</b>" }]);
  });

  it("drops outputs it does not know", () => {
    expect(only([{ output_type: "display_data", data: { "application/json": {} } }, { output_type: "weird" }, 3])).toEqual([]);
  });
});

describe("helpers", () => {
  it("stripAnsi removes colour, cursor and title codes", () => {
    expect(stripAnsi("\u001b[1;32mok\u001b[0m\u001b[2K\u001b]0;title\u0007!")).toBe("ok!");
  });
  it("fenced uses a fence longer than any backtick run in the code", () => {
    expect(fenced("a", "python")).toBe("```python\na\n```");
    expect(fenced("x ````y", "py")).toBe("`````py\nx ````y\n`````");
    expect(fenced("a", "we ird!")).toBe("```weird\na\n```");
  });
});
