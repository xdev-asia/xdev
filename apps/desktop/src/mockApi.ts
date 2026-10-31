import type { Api, ApiError, Change, ChangeKind, Commit, DocEntry, SearchHit } from "./api";

const MAX_DOC_BYTES = 5 * 1024 * 1024;
// Simulates the watcher's debounce so the UI sees its own writes echoed back, as with Tauri.
const ECHO_DELAY_MS = 300;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;

export const DEMO_ROOT = "/demo/xdev-handbook";
const COMMIT_ID = /^[0-9a-f]{4,64}$/;

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

// What an AI agent might write into the demo vault while xDev is open.
export const DEMO_OUTSIDE_EDIT = [
  "# xDev handbook",
  "",
  "Project knowledge for the xDev team. Start with the architecture notes,",
  "then read the decisions log before changing a crate boundary.",
  "",
  "- `docs/` holds the living docs.",
  "- `notes/` holds meeting notes in English and Vietnamese.",
  "- `reviews/` holds approved design reviews.",
  "",
  "Every change is reviewed in the Changes tab before it counts.",
  "",
].join("\n");

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

// Same rules as the Rust core; English on purpose, since history is shared with other people and tools.
export function defaultMessage(changes: Change[]): string {
  if (changes.length !== 1) return `Update ${changes.length} docs`;
  const [{ kind, path }] = changes;
  const verb: Record<ChangeKind, string> = { added: "Add", modified: "Update", deleted: "Delete" };
  return `${verb[kind]} ${path}`;
}

function newCommitId(): string {
  return [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type MockCommit = Commit & { tree: Map<string, string> };

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

export type MockApi = Api & {
  // Changes a file the way another program would (`null` deletes it); xDev did not write it.
  __editOutside(path: string, content: string | null): void;
};

export function createMockApi(seed: Record<string, string>, options: { repo?: boolean } = {}): MockApi {
  const files = new Map(Object.entries(seed));
  const listeners = new Set<(paths: string[]) => void>();
  let open = false;
  let last: string | null = null;
  let repo = options.repo ?? true;
  let snapshotted = false;
  // Oldest first; the last one is HEAD.
  const commits: MockCommit[] = [];
  // Path → content of xDev's last write, which is what makes a pending change `app`.
  const written = new Map<string, string>();

  function notify(paths: string[]): void {
    setTimeout(() => listeners.forEach((cb) => cb(paths)), ECHO_DELAY_MS);
  }

  function headTree(): Map<string, string> {
    return commits.at(-1)?.tree ?? new Map();
  }

  function commit(tree: Map<string, string>, message: string): string {
    const id = newCommitId();
    commits.push({ id, author: "You", time: Math.floor(Date.now() / 1000), message: message.split("\n")[0], tree });
    return id;
  }

  function pending(): Change[] {
    const head = headTree();
    const paths = new Set([...files.keys(), ...head.keys()].filter((path) => path.endsWith(".md")));
    const changes: Change[] = [];
    for (const path of paths) {
      const now = files.get(path);
      const then = head.get(path);
      if (now === then) continue;
      const kind: ChangeKind = then === undefined ? "added" : now === undefined ? "deleted" : "modified";
      const origin = kind !== "deleted" && written.get(path) === now ? "app" : "outside";
      changes.push({ path, kind, origin });
    }
    return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // Stale or crafted paths are ignored, as in the Rust core.
  function selected(paths: string[]): Change[] {
    return pending().filter((c) => paths.includes(c.path));
  }

  function vcsGuard(path?: string): ApiError["code"] | null {
    if (!open) return "no_vault";
    if (path !== undefined && isOutside(path)) return "outside_vault";
    if (!repo) return "no_repo";
    return null;
  }

  function findCommit(id: string): MockCommit | ApiError {
    if (!COMMIT_ID.test(id)) return { code: "git", detail: "bad_id" };
    return commits.find((c) => c.id.startsWith(id)) ?? { code: "git", detail: "unknown_commit" };
  }

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

  const api: MockApi = {
    async pickFolder() {
      return DEMO_ROOT;
    },
    async openVault(path) {
      open = true;
      last = path;
      if (repo && !snapshotted) commit(new Map(files), "Import docs");
      snapshotted = true;
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
      written.set(path, content);
      notify([path]);
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
    async vcsState() {
      if (!open) return reject("no_vault");
      return { status: repo ? "ok" : "no_repo" };
    },
    async initRepo() {
      if (!open) return reject("no_vault");
      repo = true;
    },
    async listChanges() {
      const bad = vcsGuard();
      return bad ? reject(bad) : pending();
    },
    async readBase(path) {
      const bad = vcsGuard(path);
      return bad ? reject(bad) : (headTree().get(path) ?? null);
    },
    async approve(paths, message) {
      const bad = vcsGuard();
      if (bad) return reject(bad);
      const chosen = selected(paths);
      if (chosen.length === 0) return null;
      const tree = new Map(headTree());
      for (const { path, kind } of chosen) {
        if (kind === "deleted") tree.delete(path);
        else tree.set(path, files.get(path)!);
        written.delete(path);
      }
      return commit(tree, message.trim() || defaultMessage(chosen));
    },
    async reject(paths) {
      const bad = vcsGuard();
      if (bad) return reject(bad);
      const chosen = selected(paths);
      const head = headTree();
      for (const { path, kind } of chosen) {
        if (kind === "added") files.delete(path);
        else files.set(path, head.get(path)!);
        written.delete(path);
      }
      if (chosen.length > 0) notify(chosen.map((c) => c.path));
    },
    async history(path, limit) {
      const bad = vcsGuard(path);
      if (bad) return reject(bad);
      // Like `git log -- path`: only commits whose version of the file differs from their parent's.
      const touched = commits.filter((c, i) => c.tree.get(path) !== commits[i - 1]?.tree.get(path));
      return touched
        .reverse()
        .slice(0, limit)
        .map(({ id, author, time, message }) => ({ id, author, time, message }));
    },
    async readVersion(path, id) {
      const bad = vcsGuard(path);
      if (bad) return reject(bad);
      const found = findCommit(id);
      if ("code" in found) return reject(found.code, found.detail);
      return found.tree.get(path) ?? null;
    },
    async restoreVersion(path, id) {
      const content = await api.readVersion(path, id);
      if (content === null) return reject("not_found");
      await api.writeDoc(path, content);
    },
    __editOutside(path, content) {
      if (content === null) files.delete(path);
      else files.set(path, content);
      notify([path]);
    },
  };
  return api;
}
