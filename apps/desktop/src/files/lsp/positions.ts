import type { Text } from "@codemirror/state";
import type { LspPos } from "@/api";

/** The LSP position of a CodeMirror offset: both count UTF-16 units, so the column is the distance from the line start. */
export function toLsp(doc: Text, offset: number): LspPos {
  const line = doc.lineAt(Math.max(0, Math.min(offset, doc.length)));
  return { line: line.number - 1, character: Math.max(0, Math.min(offset, doc.length)) - line.from };
}

/** The offset of an LSP position; a line past the end is the end, a column past the line end is the line end. */
export function fromLsp(doc: Text, pos: LspPos): number {
  if (pos.line < 0) return 0;
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1);
  return line.from + Math.max(0, Math.min(pos.character, line.length));
}

/** The offset where each line of `text` starts (lines end at "\n"). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** `fromLsp` for a plain string, with its `lineStarts`. */
export function offsetIn(text: string, starts: readonly number[], pos: LspPos): number {
  if (pos.line < 0) return 0;
  if (pos.line >= starts.length) return text.length;
  const from = starts[pos.line];
  const next = pos.line + 1 < starts.length ? starts[pos.line + 1] - 1 : text.length;
  return from + Math.max(0, Math.min(pos.character, next - from));
}
