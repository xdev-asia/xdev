// Link parsing and resolving from the M1b spec. Same rules as `xdev-vault`; both run `fixtures/links.json`.
import { eachProseLine, parseFrontmatter } from "./frontmatter";

export type Link = { kind: "wiki" | "md"; target: string };
export type Resolve = (link: Link, from: string) => string | null;

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** The doc part of a `[[...]]` body: before `|` and `#`, trimmed; null when empty. */
export function wikiTarget(inner: string): string | null {
  const target = inner.split("|")[0].split("#")[0].trim();
  return target === "" ? null : target;
}

/** The vault path part of a Markdown link href, decoded; null when it is not a link to a doc. */
export function mdTarget(href: string): string | null {
  let target = href.trim();
  const angle = /^<([^>]*)>/.exec(target);
  // Anything after the destination is an optional `"title"`.
  target = angle ? angle[1] : target.split(/\s/)[0];
  if (target === "" || SCHEME.test(target) || target.startsWith("#") || target.startsWith("//")) return null;
  target = target.split("#")[0].split("?")[0];
  if (!target.endsWith(".md")) return null;
  try {
    return decodeURIComponent(target);
  } catch {
    // A stray `%` is more likely part of the name than a broken escape.
    return target;
  }
}

// Length of the backtick run starting at `at`.
function runLength(line: string, at: number): number {
  let end = at;
  while (line[end] === "`") end++;
  return end - at;
}

// CommonMark code spans: a run of N backticks ends at the next run of exactly N; unmatched runs are literal.
function codeSpanEnd(line: string, at: number): number | null {
  const n = runLength(line, at);
  for (let i = line.indexOf("`", at + n); i !== -1; ) {
    const m = runLength(line, i);
    if (m === n) return i + m;
    i = line.indexOf("`", i + m);
  }
  return null;
}

function parseLine(line: string, links: Link[]): void {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "`") {
      const end = codeSpanEnd(line, i);
      i = end ?? i + runLength(line, i);
      continue;
    }
    if (line.startsWith("[[", i)) {
      const close = line.indexOf("]]", i + 2);
      if (close !== -1) {
        const target = wikiTarget(line.slice(i + 2, close));
        if (target !== null) links.push({ kind: "wiki", target });
        i = close + 2;
        continue;
      }
    }
    if (c === "[" && line[i - 1] !== "!") {
      const md = /^\[[^\]]*\]\(([^)]*)\)/.exec(line.slice(i));
      if (md) {
        const target = mdTarget(md[1]);
        if (target !== null) links.push({ kind: "md", target });
        i += md[0].length;
        continue;
      }
    }
    i++;
  }
}

/** Links in the order they appear, outside frontmatter and code. */
export function parseLinks(content: string): Link[] {
  const links: Link[] = [];
  eachProseLine(parseFrontmatter(content).body, (line) => parseLine(line, links));
  return links;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function stemOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

// Exact case first, then case-insensitive; `pick` chooses among several matches.
function match(docs: readonly string[], key: (doc: string) => string, wanted: string): string[] {
  const exact = docs.filter((doc) => key(doc) === wanted);
  if (exact.length > 0) return exact;
  const lower = wanted.toLowerCase();
  return docs.filter((doc) => key(doc).toLowerCase() === lower);
}

function codePoints(s: string): number {
  return [...s].length;
}

function pickByName(candidates: string[], from: string): string | null {
  if (candidates.length === 0) return null;
  const folder = folderOf(from);
  const near = candidates.find((doc) => folderOf(doc) === folder);
  if (near !== undefined) return near;
  // `candidates` keeps the sorted order, so the first shortest is also first by path.
  return candidates.reduce((best, doc) => (codePoints(doc) < codePoints(best) ? doc : best));
}

function normalize(base: string, target: string): string | null {
  const parts = target.startsWith("/") || base === "" ? [] : base.split("/");
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

/** Resolves links against the vault's doc paths (vault-relative, `/` separators). */
export function createResolver(docs: readonly string[]): Resolve {
  const sorted = [...docs].sort();
  const byPath = (path: string) => match(sorted, (doc) => doc, path)[0] ?? null;
  return (link, from) => {
    if (link.kind === "md") {
      const path = normalize(folderOf(from), link.target);
      return path === null ? null : byPath(path);
    }
    const target = link.target.replace(/\.md$/, "");
    if (target.includes("/")) return byPath(`${target.replace(/^\/+/, "")}.md`);
    return pickByName(match(sorted, stemOf, target), from);
  };
}
