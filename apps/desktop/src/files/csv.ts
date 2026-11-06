/** The field separator a file's extension implies: a tab for `.tsv` and `.tab`, a comma otherwise. */
export function delimiterOf(rel: string): string {
  return /\.(tsv|tab)$/i.test(rel) ? "\t" : ",";
}

/**
 * Splits delimited text into rows of fields. Fields may be quoted (`""` is a quote inside one), and a
 * quoted field may hold the delimiter and line breaks. A row ends at CRLF, LF or CR. A leading byte
 * order mark is dropped and the line break at the very end does not start another row.
 */
export function parseDelimited(input: string, delimiter = ","): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // True once a field has any content or a delimiter was seen on this row, so a blank line is a row.
  let started = false;
  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      started = true;
    } else if (c === delimiter) {
      endField();
      started = true;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field !== "" || quoted) endRow();
  return rows;
}

/** Rows shown at most; the rest are counted, not drawn. */
export const ROW_CAP = 5000;

export interface Grid {
  header: string[];
  /** At most `ROW_CAP` data rows, each padded to the header's width. */
  rows: string[][];
  /** Data rows beyond the cap. */
  hidden: number;
  /** Columns: the widest row. */
  columns: number;
}

/** The first row is the header; the data rows are cut at `cap` and padded to the widest row. */
export function toGrid(parsed: string[][], cap = ROW_CAP): Grid {
  const columns = parsed.reduce((n, r) => Math.max(n, r.length), 0);
  const pad = (r: string[]): string[] => (r.length >= columns ? r : [...r, ...Array<string>(columns - r.length).fill("")]);
  const [head = [], ...data] = parsed;
  return { header: pad(head), rows: data.slice(0, cap).map(pad), hidden: Math.max(0, data.length - cap), columns };
}

export interface Cell {
  /** Data row index; -1 is the header. */
  row: number;
  col: number;
}

/** Cells whose text holds `query` (ignoring case), header first, in reading order. An empty query matches nothing. */
export function findCells(grid: Grid, query: string): Cell[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: Cell[] = [];
  const scan = (cells: string[], row: number): void =>
    cells.forEach((value, col) => {
      if (value.toLowerCase().includes(q)) out.push({ row, col });
    });
  scan(grid.header, -1);
  grid.rows.forEach((r, i) => scan(r, i));
  return out;
}
