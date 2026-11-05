import type { Api, ApiError, Eol, FileHits, FileText, FsEvent, SearchQuery } from "./api";

type FilesApi = Pick<
  Api,
  "fileRead" | "fileWrite" | "fileCreate" | "fileRename" | "fileTrash" | "fileReveal" | "filesList" | "filesSearch" | "filesSearchCancel" | "filesWatch" | "filesUnwatch"
>;

export type MockFiles = FilesApi & {
  // Changes a file the way another program would (`null` deletes it); for conflict demos and tests.
  __editFile(worktree: string, rel: string, text: string | null): void;
  // Tells every watcher of `worktree` that it overflowed; the UI re-reads everything.
  __overflow(worktree: string): void;
  // Every live `filesWatch` subscription.
  __watchers(): { worktree: string; id: string }[];
  // Every `fileReveal`, oldest first.
  __fileReveals(): { worktree: string; rel: string }[];
  // The files and the folders of `worktree` now, for its listing; null for an unknown worktree.
  tree(worktree: string): { files: string[]; dirs: Set<string> } | null;
};

/** `READ_MAX` in Rust: larger files are not read. */
export const MOCK_READ_MAX = 2 * 1024 * 1024;
const BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|zip|woff2?)$/i;

// A stand-in for Rust's blake3 hex: the same text gives the same hash.
export function mockHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

/** The text a base file has until something writes it. */
function seedText(rel: string): string {
  const name = rel.split("/").pop() ?? rel;
  if (rel.endsWith(".md")) return `# ${name.replace(/\.md$/, "")}\n\nA demo file.\n`;
  if (rel.endsWith(".json")) return `{\n  "name": "demo"\n}\n`;
  return `// ${rel}\nexport {};\n`;
}

/** `rel` with `.` parts dropped; null when Rust's `rel_under` would refuse it. */
function plain(rel: string): string | null {
  if (rel.startsWith("/") || rel.includes("\\") || rel.includes(":")) return null;
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === ".." || p.toLowerCase() === ".git")) return null;
  return parts.join("/");
}

function parentOf(rel: string): string {
  const cut = rel.lastIndexOf("/");
  return cut === -1 ? "" : rel.slice(0, cut);
}

function eolOf(text: string): Eol {
  const lf = text.indexOf("\n");
  return lf > 0 && text[lf - 1] === "\r" ? "crlf" : "lf";
}

type Overlay = { written: Map<string, string>; dirs: Set<string>; removed: Set<string> };

/**
 * The files of each worktree in memory: `base` lists what a worktree starts with (null when it is
 * not known), and writes, creates, renames and trashes lie over it.
 */
export function createMockFiles(base: (worktree: string) => string[] | null): MockFiles {
  const overlays = new Map<string, Overlay>();
  const reveals: { worktree: string; rel: string }[] = [];
  // Search id → its current run; a cancel or a newer run makes an older one stop.
  const runs = new Map<string, number>();
  // Watch id → its worktree and listener.
  const watchers = new Map<string, { worktree: string; onEvent: Parameters<Api["filesWatch"]>[2] }>();

  // Delivers one batch to every watcher of `worktree`, as the Rust watcher would.
  function emit(worktree: string, events: FsEvent[]): void {
    for (const w of [...watchers.values()]) if (w.worktree === worktree) w.onEvent({ worktree, events });
  }

  function overlay(worktree: string): Overlay {
    let o = overlays.get(worktree);
    if (!o) overlays.set(worktree, (o = { written: new Map(), dirs: new Set(), removed: new Set() }));
    return o;
  }

  function tree(worktree: string): { files: string[]; dirs: Set<string> } | null {
    const seeded = base(worktree);
    if (seeded === null) return null;
    const o = overlay(worktree);
    const files = [...new Set([...seeded, ...o.written.keys()])].filter((f) => !o.removed.has(f));
    const dirs = new Set<string>();
    for (const f of files) for (let d = parentOf(f); d !== ""; d = parentOf(d)) dirs.add(d);
    for (const d of o.dirs) if (!o.removed.has(d)) dirs.add(d);
    return { files, dirs };
  }

  function textOf(worktree: string, rel: string): string {
    return overlay(worktree).written.get(rel) ?? seedText(rel);
  }

  // Checks the worktree and the path; the tree and the plain path when both are usable.
  function open(worktree: string, rel: string) {
    const t = tree(worktree);
    if (!t) return reject("worktree_unknown", worktree);
    const p = plain(rel);
    if (p === null) return reject("bad_path", rel);
    return { t, p, o: overlay(worktree) };
  }

  function put(o: Overlay, rel: string, text: string): void {
    o.written.set(rel, text);
    o.removed.delete(rel);
  }

  return {
    tree,
    async fileRead(worktree, rel) {
      const at = open(worktree, rel);
      if (at instanceof Promise) return at;
      if (at.t.dirs.has(at.p)) return reject("bad_path", rel);
      if (!at.t.files.includes(at.p)) return reject("not_found", rel);
      const text = textOf(worktree, at.p);
      const out: FileText = { rel, text, kind: "text", size: text.length, hash: mockHash(text), eol: eolOf(text) };
      if (BINARY.test(at.p)) return { ...out, text: null, kind: "binary" };
      if (text.length > MOCK_READ_MAX) return { ...out, text: null, kind: "tooLarge", hash: "" };
      return out;
    },
    async fileWrite(worktree, rel, text, eol, expected) {
      const at = open(worktree, rel);
      if (at instanceof Promise) return at;
      if (at.t.dirs.has(at.p)) return reject("bad_path", rel);
      const parent = parentOf(at.p);
      if (parent !== "" && !at.t.dirs.has(parent)) return reject("not_found", rel);
      const disk = at.t.files.includes(at.p) ? mockHash(textOf(worktree, at.p)) : null;
      if (disk !== expected) return { type: "conflict", diskHash: disk ?? "" };
      const lf = text.replace(/\r\n?/g, "\n");
      const bytes = eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf;
      put(at.o, at.p, bytes);
      emit(worktree, [{ kind: disk === null ? "create" : "update", rel: at.p, dir: false }]);
      return { type: "saved", hash: mockHash(bytes) };
    },
    async fileCreate(worktree, rel, dir) {
      const at = open(worktree, rel);
      if (at instanceof Promise) return at;
      if (at.t.files.includes(at.p) || at.t.dirs.has(at.p)) return reject("exists", rel);
      const parent = parentOf(at.p);
      if (parent !== "" && !at.t.dirs.has(parent)) return reject("not_found", rel);
      if (dir) {
        at.o.dirs.add(at.p);
        at.o.removed.delete(at.p);
      } else put(at.o, at.p, "");
      emit(worktree, [{ kind: "create", rel: at.p, dir }]);
    },
    async fileRename(worktree, from, to) {
      const src = open(worktree, from);
      if (src instanceof Promise) return src;
      const dst = plain(to);
      if (dst === null) return reject("bad_path", to);
      const { t, p, o } = src;
      const isDir = t.dirs.has(p);
      if (!isDir && !t.files.includes(p)) return reject("not_found", from);
      // A change of case only is the same entry, as on a case-insensitive disk.
      const caseOnly = dst !== p && dst.toLowerCase() === p.toLowerCase();
      if (!caseOnly && (t.files.includes(dst) || t.dirs.has(dst))) return reject("exists", to);
      const parent = parentOf(dst);
      if (parent !== "" && !t.dirs.has(parent)) return reject("not_found", to);
      if (isDir && within(dst, p)) return reject("bad_path", to);
      const moved = isDir ? t.files.filter((f) => within(f, p)) : [p];
      for (const f of moved) {
        const text = textOf(worktree, f);
        o.removed.add(f);
        o.written.delete(f);
        put(o, dst + f.slice(p.length), text);
      }
      if (isDir) {
        for (const d of [...t.dirs].filter((d) => within(d, p))) {
          o.removed.add(d);
          o.dirs.delete(d);
          o.dirs.add(dst + d.slice(p.length));
          o.removed.delete(dst + d.slice(p.length));
        }
      }
      emit(worktree, [
        { kind: "delete", rel: p, dir: null },
        { kind: "create", rel: dst, dir: isDir },
      ]);
    },
    async fileTrash(worktree, rel) {
      const at = open(worktree, rel);
      if (at instanceof Promise) return at;
      const { t, p, o } = at;
      if (!t.dirs.has(p) && !t.files.includes(p)) return reject("not_found", rel);
      // Every entry under it by name, so a later folder of the same name starts empty.
      for (const f of t.files) if (within(f, p)) o.removed.add(f);
      for (const d of t.dirs) if (within(d, p)) o.removed.add(d);
      for (const f of [...o.written.keys()]) if (within(f, p)) o.written.delete(f);
      for (const d of [...o.dirs]) if (within(d, p)) o.dirs.delete(d);
      emit(worktree, [{ kind: "delete", rel: p, dir: null }]);
    },
    async fileReveal(worktree, rel) {
      const at = open(worktree, rel);
      if (at instanceof Promise) return at;
      reveals.push({ worktree, rel: at.p });
    },
    async filesList(worktree) {
      const t = tree(worktree);
      if (!t) return reject("worktree_unknown", worktree);
      return { files: [...t.files].sort(), truncated: false };
    },
    async filesSearch(worktree, query, id, onEvent) {
      const t = tree(worktree);
      if (!t) return reject("worktree_unknown", worktree);
      // A new search with this id cancels the old one, which then sends nothing more.
      const run = (runs.get(id) ?? 0) + 1;
      runs.set(id, run);
      const started = Date.now();
      let compiled: { re: RegExp; keep: (rel: string) => boolean };
      try {
        compiled = compileQuery(query);
      } catch (e) {
        onEvent({ type: "error", message: e instanceof Error ? e.message : String(e) });
        return;
      }
      // Lets a cancel or a newer search with this id land first, as on a real walk.
      await Promise.resolve();
      if (runs.get(id) !== run) return;
      const found: FileHits[] = [];
      let hits = 0;
      for (const rel of [...t.files].sort()) {
        if (BINARY.test(rel) || !compiled.keep(rel)) continue;
        const lines = textOf(worktree, rel).split("\n");
        const fileHits: FileHits = { rel, hits: [], more: false };
        lines.forEach((raw, i) => {
          const text = raw.replace(/\r$/, "");
          const ranges: [number, number][] = [];
          for (const m of text.matchAll(compiled.re)) {
            if (m[0].length > 0) ranges.push([m.index, m.index + m[0].length]);
          }
          if (ranges.length > 0) fileHits.hits.push({ line: i + 1, text, ranges });
        });
        if (fileHits.hits.length > 0) {
          found.push(fileHits);
          hits += fileHits.hits.length;
        }
      }
      if (found.length > 0) onEvent({ type: "batch", files: found });
      onEvent({ type: "done", files: found.length, hits, truncated: false, ms: Date.now() - started });
      runs.delete(id);
    },
    async filesSearchCancel(id) {
      if (runs.has(id)) runs.set(id, (runs.get(id) ?? 0) + 1);
    },
    async filesWatch(worktree, id, onEvent) {
      if (!tree(worktree)) return reject("worktree_unknown", worktree);
      watchers.set(id, { worktree, onEvent });
    },
    async filesUnwatch(id) {
      watchers.delete(id);
    },
    __watchers: () => [...watchers].map(([id, w]) => ({ worktree: w.worktree, id })),
    __overflow: (worktree) => emit(worktree, [{ kind: "overflow", rel: "", dir: null }]),
    __editFile(worktree, rel, text) {
      const o = overlay(worktree);
      const existed = tree(worktree)?.files.includes(rel) ?? false;
      if (text === null) {
        o.written.delete(rel);
        o.removed.add(rel);
        emit(worktree, [{ kind: "delete", rel, dir: null }]);
      } else {
        put(o, rel, text);
        emit(worktree, [{ kind: existed ? "update" : "create", rel, dir: false }]);
      }
    },
    __fileReveals: () => structuredClone(reveals),
  };
}

// Whether `path` is `base` or lies under it.
function within(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/** The regex and the include / exclude filter of `q`, as Rust builds them; throws on a bad regex. */
function compileQuery(q: SearchQuery): { re: RegExp; keep: (rel: string) => boolean } {
  if (q.text.length === 0 || q.text.length > 1000) throw new Error("the search text must be 1 to 1000 chars");
  let source = q.regex ? q.text : q.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (q.wholeWord) source = `\\b(?:${source})\\b`;
  const re = new RegExp(source, q.caseSensitive ? "gu" : "giu");
  const include = q.include.map(globToRegExp);
  const exclude = q.exclude.map(globToRegExp);
  const keep = (rel: string) =>
    (include.length === 0 || include.some((g) => g.test(rel))) && !exclude.some((g) => g.test(rel));
  return { re, keep };
}

/** A gitignore-style glob: `*` within a name, `**` across folders; no `/` matches at any depth. */
function globToRegExp(glob: string): RegExp {
  let body = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      body += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") body += "[^/]*";
    else if (c === "?") body += "[^/]";
    else body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return glob.includes("/") ? new RegExp(`^${body.replace(/^\//, "")}$`) : new RegExp(`(^|/)${body}$`);
}
