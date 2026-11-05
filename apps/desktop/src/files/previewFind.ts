/** A match of the query inside one text node. */
export interface FindMatch {
  node: number;
  start: number;
  end: number;
}

/** Case-insensitive, non-overlapping matches of `query` in each text, in document order. */
export function findMatches(texts: readonly string[], query: string): FindMatch[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const out: FindMatch[] = [];
  texts.forEach((text, node) => {
    const hay = text.toLowerCase();
    // Lower-casing can change the length (rare scripts); offsets would then lie, so skip that node.
    if (hay.length !== text.length) return;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) out.push({ node, start: at, end: at + needle.length });
  });
  return out;
}

/** The match after (`dir` 1) or before (`dir` -1) `current`, wrapping; -1 when there are none. */
export function stepMatch(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  return (((current + dir) % count) + count) % count;
}

interface Registry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

/** CSS Custom Highlight registry and constructor, when the webview has them. */
function highlightApi(): { registry: Registry; make: new (...ranges: Range[]) => unknown } | null {
  const registry = (globalThis as { CSS?: { highlights?: Registry } }).CSS?.highlights;
  const make = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return registry && make ? { registry, make } : null;
}

const SKIP = "button, script, style";
const MARK = "md-find-mark";

function textNodes(root: Element): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue && !n.parentElement?.closest(SKIP)) out.push(n as Text);
  }
  return out;
}

/** Removes every highlight `highlightMatches` drew, `<mark>` fallback included. */
export function clearHighlights(root: Element | null): void {
  const api = highlightApi();
  api?.registry.delete("md-find");
  api?.registry.delete("md-find-current");
  if (!root) return;
  const marks = Array.from(root.querySelectorAll(`mark.${MARK}`));
  for (const mark of marks) mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  if (marks.length) root.normalize();
}

/** Highlights `query` under `root`; the `current` match is marked apart. Returns the match count. */
export function highlightMatches(root: Element, query: string, current: number): number {
  clearHighlights(root);
  const nodes = textNodes(root);
  const matches = findMatches(
    nodes.map((n) => n.data),
    query,
  );
  const ranges = matches.map((m) => {
    const range = document.createRange();
    range.setStart(nodes[m.node], m.start);
    range.setEnd(nodes[m.node], m.end);
    return range;
  });
  const api = highlightApi();
  if (api) {
    api.registry.set("md-find", new api.make(...ranges));
    const at = ranges[current];
    if (at) api.registry.set("md-find-current", new api.make(at));
    at?.startContainer.parentElement?.scrollIntoView?.({ block: "center" });
    return ranges.length;
  }
  // No Highlight API: wrap from the end so earlier offsets stay valid.
  const marks: HTMLElement[] = [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const mark = document.createElement("mark");
    mark.className = i === current ? `${MARK} md-find-current` : MARK;
    ranges[i].surroundContents(mark);
    marks[i] = mark;
  }
  marks[current]?.scrollIntoView?.({ block: "center" });
  return ranges.length;
}
