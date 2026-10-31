import type { Api, ApiError, DocEntry, SearchHit } from "./api";

const MAX_DOC_BYTES = 5 * 1024 * 1024;
// Simulates the watcher's debounce so the UI sees its own writes echoed back, as with Tauri.
const ECHO_DELAY_MS = 300;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;

export const DEMO_ROOT = "/demo/xdev-handbook";

export const DEMO_SEED: Record<string, string> = {
  "README.md": [
    "# xDev handbook",
    "",
    "Project knowledge for the xDev team. Start with the architecture notes,",
    "then read the decisions log before changing a crate boundary.",
    "",
    "- `docs/` holds the living docs.",
    "- `notes/` holds meeting notes in English and Vietnamese.",
    "",
  ].join("\n"),
  "docs/architecture/tai-lieu-kien-truc.md": [
    "# Tài liệu kiến trúc",
    "",
    "Hệ thống gồm ba lớp: vault đọc và ghi tệp Markdown, store giữ chỉ mục SQLite,",
    "core nối hai lớp này lại với nhau.",
    "",
    "## Nguyên tắc",
    "",
    "- Tệp trên ổ đĩa luôn là nguồn sự thật.",
    "- Chỉ mục có thể xoá và dựng lại bất cứ lúc nào.",
    "",
  ].join("\n"),
  "docs/architecture/decisions.md": [
    "# Architecture decisions",
    "",
    "## 001: SQLite FTS5 for search",
    "",
    "Search must work offline and ignore Vietnamese diacritics, so we use the",
    "unicode61 tokenizer with remove_diacritics.",
    "",
  ].join("\n"),
  "docs/guides/getting-started.md": [
    "# Getting started",
    "",
    "Install the toolchain, then run `pnpm install` and `pnpm --filter desktop dev`.",
    "Open any folder of Markdown files to try search.",
    "",
  ].join("\n"),
  "notes/2026/hop-giao-ban.md": [
    "# Họp giao ban tuần 44",
    "",
    "- Hoàn thành bản M0: mở thư mục, sửa tài liệu, tìm kiếm.",
    "- Việc tiếp theo: liên kết giữa các tài liệu và xuất cho AI agent.",
    "",
  ].join("\n"),
  "notes/scratch.md": "Quick notes without a heading.\n\nThe title falls back to the file name.\n",
  // Shows how a skipped file looks in the list.
  "notes/legacy-export.md": "# Legacy export\n\nBroken encoding: \uD800\n",
};

function reject(code: ApiError["code"]): Promise<never> {
  const error: ApiError = { code };
  return Promise.reject(error);
}

// Mirrors the Rust vault: no `..` segments and nothing absolute (POSIX, UNC or drive letter).
function isOutside(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path) || path.split(/[/\\]/).includes("..");
}

function titleOf(path: string, content: string): string {
  const heading = content.split("\n").find((line) => line.startsWith("# "));
  if (heading) return heading.slice(2).trim();
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function skipReason(content: string): DocEntry["skipped"] {
  // A lone surrogate cannot be encoded as UTF-8, so it stands in for a non-UTF-8 file.
  if (/\p{Cs}/u.test(content)) return "not_utf8";
  if (new TextEncoder().encode(content).length > MAX_DOC_BYTES) return "too_large";
  return null;
}

type Folded = { text: string; origin: number[] };

// Folds case and diacritics while remembering where each folded char came from,
// so a match in the folded text can be highlighted in the original.
function fold(input: string): Folded {
  let text = "";
  const origin: number[] = [];
  let i = 0;
  for (const ch of input) {
    // NFD does not split đ into d + mark, but Vietnamese users type "d" for it.
    const folded = ch
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/đ/g, "d");
    for (const f of folded) {
      text += f;
      origin.push(i);
    }
    i += ch.length;
  }
  origin.push(i);
  return { text, origin };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Range = [number, number];

function findAll(source: Folded, original: string, terms: string[]): Range[] {
  const ranges: Range[] = [];
  for (const term of terms) {
    let at = source.text.indexOf(term);
    while (at !== -1) {
      const start = source.origin[at];
      // The end maps to the start of the next original char, covering any combining marks.
      const end = source.origin[at + term.length] ?? original.length;
      ranges.push([start, end]);
      at = source.text.indexOf(term, at + term.length);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

// Same contract as the store: escaped text with hits wrapped in <mark>, trimmed to a window.
function snippet(text: string, terms: string[]): string | null {
  const ranges = findAll(fold(text), text, terms);
  if (ranges.length === 0) return null;
  const [first, firstEnd] = ranges[0];
  let from = Math.max(0, first - SNIPPET_BEFORE);
  let to = Math.min(text.length, firstEnd + SNIPPET_AFTER);
  // Snap to word boundaries, never cutting into the first hit.
  const startSpace = text.indexOf(" ", from);
  if (from > 0 && startSpace !== -1 && startSpace < first) from = startSpace + 1;
  const endSpace = text.lastIndexOf(" ", to);
  if (to < text.length && endSpace > firstEnd) to = endSpace;
  let out = from > 0 ? "…" : "";
  let cursor = from;
  for (const [start, end] of ranges) {
    if (start < cursor || end > to) continue;
    out += escapeHtml(text.slice(cursor, start)) + "<mark>" + escapeHtml(text.slice(start, end)) + "</mark>";
    cursor = end;
  }
  out += escapeHtml(text.slice(cursor, to)) + (to < text.length ? "…" : "");
  return out.replace(/\s+/g, " ").trim();
}

export function createMockApi(seed: Record<string, string>): Api {
  const files = new Map(Object.entries(seed));
  const listeners = new Set<(paths: string[]) => void>();
  let open = false;
  let last: string | null = null;

  function entries(): DocEntry[] {
    return [...files.keys()]
      .filter((path) => path.endsWith(".md"))
      .sort()
      .map((path) => {
        const content = files.get(path)!;
        const skipped = skipReason(content);
        return {
          path,
          title: skipped ? titleOf(path, "") : titleOf(path, content),
          size: new TextEncoder().encode(content).length,
          skipped,
        };
      });
  }

  function guard(path: string): ApiError["code"] | null {
    if (!open) return "no_vault";
    if (isOutside(path)) return "outside_vault";
    return null;
  }

  return {
    async pickFolder() {
      return DEMO_ROOT;
    },
    async openVault(path) {
      open = true;
      last = path;
      return entries();
    },
    async lastVault() {
      return last;
    },
    async listDocs() {
      return open ? entries() : reject("no_vault");
    },
    async readDoc(path) {
      const bad = guard(path);
      if (bad) return reject(bad);
      const content = files.get(path);
      if (content === undefined) return reject("not_found");
      const skipped = skipReason(content);
      return skipped ? reject(skipped) : content;
    },
    async writeDoc(path, content) {
      const bad = guard(path);
      if (bad) return reject(bad);
      files.set(path, content);
      setTimeout(() => listeners.forEach((cb) => cb([path])), ECHO_DELAY_MS);
    },
    async search(query, limit) {
      if (!open) return reject("no_vault");
      const terms = fold(query).text.split(/\s+/).filter(Boolean);
      if (terms.length === 0) return [];
      const hits: SearchHit[] = [];
      for (const doc of entries()) {
        if (doc.skipped) continue;
        const body = files.get(doc.path)!;
        const haystack = fold(`${doc.title}\n${body}`).text;
        if (!terms.every((term) => haystack.includes(term))) continue;
        const text = snippet(body, terms) ?? snippet(doc.title, terms) ?? escapeHtml(doc.title);
        hits.push({ path: doc.path, title: doc.title, snippet: text });
      }
      return hits.slice(0, limit);
    },
    async onVaultChanged(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}
