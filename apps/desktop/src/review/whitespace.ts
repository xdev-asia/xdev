import { Change, diff } from "@codemirror/merge";

/** Above this many lines on a side the default diff is used and the toggle is unavailable. */
export const WHITESPACE_LINE_LIMIT = 5000;
/** The most edits the line diff explores before it gives up and reports the middle as one change. */
const MAX_EDITS = 2000;

type Line = { key: string; from: number; to: number };

function split(text: string): Line[] {
  const out: Line[] = [];
  let from = 0;
  while (from < text.length) {
    const nl = text.indexOf("\n", from);
    const end = nl < 0 ? text.length : nl;
    const to = nl < 0 ? text.length : nl + 1;
    const key = text.slice(from, end).replace(/[ \t]+/g, " ").trim();
    out.push({ key, from, to });
    from = to;
  }
  return out;
}

export function whitespaceSupported(a: string, b: string): boolean {
  const count = (t: string) => (t.match(/\n/g)?.length ?? 0) + 1;
  return count(a) <= WHITESPACE_LINE_LIMIT && count(b) <= WHITESPACE_LINE_LIMIT;
}

/** Myers: the index pairs of matching lines, or null when more than MAX_EDITS edits are needed. */
function matches(a: string[], b: string[]): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m, offset);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], d: number, n: number, m: number, offset: number): [number, number][] {
  const out: [number, number][] = [];
  let x = n;
  let y = m;
  for (let dd = d; dd > 0; dd--) {
    const pv = trace[dd];
    const k = x - y;
    const down = k === -dd || (k !== dd && pv[offset + k - 1] < pv[offset + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = pv[offset + pk];
    const py = px - pk;
    // The diagonal run after the single edit step.
    const sx = down ? px : px + 1;
    while (x > sx) {
      x--;
      y--;
      out.push([x, y]);
    }
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    out.push([x, y]);
  }
  return out.reverse();
}

/** A line diff that treats lines as equal when they match after collapsing runs of blanks and trimming. */
export function ignoreWhitespaceDiff(a: string, b: string): readonly Change[] {
  if (!whitespaceSupported(a, b)) return diff(a, b);
  const la = split(a);
  const lb = split(b);
  let head = 0;
  while (head < la.length && head < lb.length && la[head].key === lb[head].key) head++;
  let tail = 0;
  while (tail < la.length - head && tail < lb.length - head && la[la.length - 1 - tail].key === lb[lb.length - 1 - tail].key) tail++;
  const ma = la.slice(head, la.length - tail);
  const mb = lb.slice(head, lb.length - tail);
  if (ma.length === 0 && mb.length === 0) return [];
  const pairs =
    matches(
      ma.map((l) => l.key),
      mb.map((l) => l.key),
    ) ?? [];
  const changes: Change[] = [];
  const startA = (i: number) => (head + i < la.length ? la[head + i].from : a.length);
  const startB = (j: number) => (head + j < lb.length ? lb[head + j].from : b.length);
  let i = 0;
  let j = 0;
  const flush = (ni: number, nj: number) => {
    if (ni > i || nj > j) changes.push(new Change(startA(i), startA(ni), startB(j), startB(nj)));
  };
  for (const [pi, pj] of pairs) {
    flush(pi, pj);
    i = pi + 1;
    j = pj + 1;
  }
  flush(ma.length, mb.length);
  return changes;
}

/** True when the texts differ but every difference is whitespace. */
export function onlyWhitespace(a: string, b: string): boolean {
  return a !== b && ignoreWhitespaceDiff(a, b).length === 0;
}
