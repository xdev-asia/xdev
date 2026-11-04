/** One conflict block, as line indexes (0-based) of its markers. */
export interface ConflictBlock {
  /** The `<<<<<<<` line. */
  start: number;
  /** The `|||||||` line of a diff3 block. */
  base?: number;
  /** The `=======` line. */
  mid: number;
  /** The `>>>>>>>` line. */
  end: number;
}

export type ConflictChoice = "current" | "incoming" | "both";

const OPEN = /^<{7}(?: .*)?$/;
const BASE = /^\|{7}(?: .*)?$/;
const MID = /^={7}$/;
const CLOSE = /^>{7}(?: .*)?$/;

// Lines keep their own line ending, so a rewrite does not change CRLF files.
const linesOf = (text: string): string[] => text.split(/(?<=\n)/);
const bare = (line: string): string => line.replace(/\r?\n$/, "");

/**
 * The complete conflict blocks of a text. A marker has exactly seven characters at the start of the line.
 * A block that never closes, and a divider outside a block, give nothing; an opening marker inside an
 * open block starts it over. Markers inside a markdown code fence count too: git writes real markers there
 * when two branches edit the same code sample, and a missed block could be saved with its markers.
 */
export function parseConflicts(text: string): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let open: { start: number; base?: number; mid?: number } | null = null;
  linesOf(text).forEach((raw, i) => {
    const line = bare(raw);
    if (OPEN.test(line)) open = { start: i };
    else if (!open) return;
    else if (BASE.test(line) && open.mid === undefined && open.base === undefined) open.base = i;
    else if (MID.test(line) && open.mid === undefined) open.mid = i;
    else if (CLOSE.test(line) && open.mid !== undefined) {
      blocks.push({ start: open.start, ...(open.base !== undefined ? { base: open.base } : {}), mid: open.mid, end: i });
      open = null;
    }
  });
  return blocks;
}

/** The text with one block replaced by its current side, its incoming side, or both (current first). */
export function resolveBlock(text: string, block: ConflictBlock, choice: ConflictChoice): string {
  const lines = linesOf(text);
  const current = lines.slice(block.start + 1, block.base ?? block.mid);
  const incoming = lines.slice(block.mid + 1, block.end);
  const kept = choice === "current" ? current : choice === "incoming" ? incoming : [...current, ...incoming];
  const after = lines.slice(block.end + 1);
  // The closing marker was the last line and had no line ending: the kept text does not gain one.
  if (after.length === 0 && !/\n$/.test(lines[block.end]) && kept.length > 0) kept[kept.length - 1] = bare(kept[kept.length - 1]);
  return [...lines.slice(0, block.start), ...kept, ...after].join("");
}
