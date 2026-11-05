// The terminal's links: file paths (a link provider), http(s) URLs (the web-links addon's handler)
// and OSC 8 hyperlinks (xterm's `linkHandler`). Everything here is plain functions over small
// interfaces, so the tests drive it with a fake buffer and a fake api.
import type { IBufferRange, ILink, ILinkHandler, ILinkProvider } from "@xterm/xterm";
import { findFileLinks, formatLocation, parseLocation } from "./fileLinks";
import { linkAction, linkHint, type LinkAction, type LinkKind, type LinkSettings } from "./linkGesture";
import { fileLinkMenu, openDefaultLink, openFileLink, openUrlLink, urlLinkMenu, type FileTarget, type LinkDeps, type LinkMenu } from "./linkMenu";

/** How long an answer of the backend is kept for the same printed text. */
export const RESOLVE_TTL_MS = 5000;
/** Most candidates one backend call takes. */
export const RESOLVE_BATCH = 64;
// A logical line longer than this (in cells) is not scanned.
const MAX_LOGICAL = 4096;

export type Resolve = (worktree: string, paths: string[], cwd?: string) => Promise<(string | null)[]>;

/**
 * Asks the backend which printed paths are files of the worktree, caching each answer for 5 s,
 * including one still pending, so a row hovered again costs nothing. A failed call caches nothing
 * and answers `null` for its paths.
 */
export function createLinkResolver(resolve: Resolve, now: () => number = Date.now): Resolve {
  const cache = new Map<string, { at: number; value: Promise<string | null> }>();
  return async (worktree, paths, cwd) => {
    const scope = `${worktree}\0${cwd ?? ""}`;
    const unique = [...new Set(paths)];
    const missing = unique.filter((p) => {
      const hit = cache.get(`${scope}\0${p}`);
      return !hit || now() - hit.at >= RESOLVE_TTL_MS;
    });
    for (let from = 0; from < missing.length; from += RESOLVE_BATCH) {
      const batch = missing.slice(from, from + RESOLVE_BATCH);
      const answer = resolve(worktree, batch, cwd);
      batch.forEach((path, i) => {
        const key = `${scope}\0${path}`;
        const value = answer.then((rels) => rels[i] ?? null);
        cache.set(key, { at: now(), value });
        value.catch(() => {
          if (cache.get(key)?.value === value) cache.delete(key);
        });
      });
    }
    return Promise.all(
      paths.map((p) => cache.get(`${scope}\0${p}`)?.value.catch(() => null) ?? Promise.resolve(null)),
    );
  };
}

/**
 * The folder an OSC 7 report (`file://host/path`, percent-encoded) names; undefined for anything
 * else. A Windows drive path `/C:/x` is read as `C:/x`.
 */
export function cwdFromOsc7(data: string): string | undefined {
  const m = /^file:\/\/[^/]*(\/.*)$/i.exec(data.trim());
  if (!m || m[1]!.length > 4096) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(m[1]!);
  } catch {
    return undefined;
  }
  if (path.includes("\0")) return undefined;
  return /^\/[A-Za-z]:(\/|$)/.test(path) ? path.slice(1) : path;
}

/** The bits of an xterm buffer the provider reads. */
export interface BufferCellLike {
  getChars(): string;
  getWidth(): number;
}
export interface BufferLineLike {
  isWrapped: boolean;
  length: number;
  getCell(x: number): BufferCellLike | undefined;
}
export interface BufferLike {
  length: number;
  getLine(y: number): BufferLineLike | undefined;
}

// One UTF-16 unit of a logical line: the buffer row it is on and its first cell (0-based) and width.
type Spot = { row: number; col: number; width: number };
type Logical = { text: string; spots: Spot[]; first: number };

/** The text of the logical line (wrapped rows joined) that holds buffer row `row` (0-based). */
export function logicalLine(buffer: BufferLike, row: number): Logical | null {
  if (!buffer.getLine(row)) return null;
  let first = row;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = "";
  const spots: Spot[] = [];
  for (let y = first; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line || (y > first && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      const width = cell?.getWidth() ?? 1;
      // The second cell of a wide character holds nothing.
      if (width === 0) continue;
      const chars = cell?.getChars() || " ";
      text += chars;
      for (let i = 0; i < chars.length; i++) spots.push({ row: y, col: x, width });
    }
    if (text.length > MAX_LOGICAL) return null;
  }
  return { text, spots, first };
}

/** `[start, end)` of `text` as an xterm range: 1-based cells, the end cell included. */
function rangeOf(spots: Spot[], start: number, end: number): IBufferRange {
  const a = spots[start]!;
  const b = spots[end - 1]!;
  return { start: { x: a.col + 1, y: a.row + 1 }, end: { x: b.col + b.width, y: b.row + 1 } };
}

/** What the terminal gives these functions. */
export interface TermLinksEnv {
  /** The tab's worktree; without one no file link is made. */
  worktree(): string | undefined;
  /** The shell's folder as the program last reported it (OSC 7), when known. */
  cwd?(): string | undefined;
  buffer(): BufferLike;
  resolve: Resolve;
  settings(): LinkSettings;
  mac: boolean;
  deps: LinkDeps;
  /** Shows the action menu; false (or no function) when there is nowhere to show it, and the click then opens the target. */
  showMenu?(at: { x: number; y: number }, menu: LinkMenu): boolean;
  /** Shows the hover tip, or hides it with `null`. */
  tip(text: string | null): void;
}

function perform(env: TermLinksEnv, action: LinkAction, e: MouseEvent, run: { open(): unknown; openDefault(): unknown; menu(): LinkMenu }): void {
  if (action === "none") return;
  if (action === "menu" && env.showMenu?.({ x: e.clientX, y: e.clientY }, run.menu())) return;
  if (action === "openDefault") void run.openDefault();
  else void run.open();
}

function fileRun(env: TermLinksEnv, target: FileTarget, shown?: string) {
  return {
    open: () => openFileLink(target, env.deps),
    openDefault: () => openDefaultLink(target, env.deps),
    menu: () => fileLinkMenu(target, env.deps, shown),
  };
}

function urlRun(env: TermLinksEnv, url: string) {
  return {
    open: () => openUrlLink(url, env.deps),
    openDefault: () => openUrlLink(url, env.deps),
    menu: () => urlLinkMenu(url, env.deps),
  };
}

const hint = (env: TermLinksEnv, kind: LinkKind, target: string) => linkHint(kind, target, env.settings().linkClick, env.mac, env.deps.t);

/** The file link provider: a link only for a path the backend says is a file of the worktree. */
export function createFileLinkProvider(env: TermLinksEnv): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const worktree = env.worktree();
      const before = worktree ? logicalLine(env.buffer(), y - 1) : null;
      if (!worktree || !before) return callback(undefined);
      // Candidates that touch this row only; the others belong to their own rows.
      const found = findFileLinks(before.text).filter((c) => before.spots[c.start]!.row <= y - 1 && before.spots[c.end - 1]!.row >= y - 1);
      if (found.length === 0) return callback(undefined);
      const paths = [...new Set(found.map((c) => c.path))].slice(0, RESOLVE_BATCH);
      void env.resolve(worktree, paths, env.cwd?.()).then(
        (rels) => {
          // The row changed while the backend was thinking: its answer is for other text.
          if (logicalLine(env.buffer(), y - 1)?.text !== before.text) return callback(undefined);
          const links: ILink[] = [];
          for (const c of found) {
            const rel = rels[paths.indexOf(c.path)];
            if (!rel) continue;
            const target: FileTarget = { worktree, rel, ...(c.line !== undefined ? { line: c.line } : {}), ...(c.column !== undefined ? { column: c.column } : {}) };
            links.push({
              range: rangeOf(before.spots, c.start, c.end),
              text: before.text.slice(c.start, c.end),
              activate(e) {
                perform(env, linkAction("file", e, env.settings(), env.mac), e, fileRun(env, target));
              },
              hover: () => env.tip(hint(env, "file", formatLocation(rel, c.line, c.column))),
              leave: () => env.tip(null),
            });
          }
          callback(links.length > 0 ? links : undefined);
        },
        () => callback(undefined),
      );
    },
  };
}

/** The handler and the tip callbacks for `WebLinksAddon`. */
export function urlLinkOptions(env: TermLinksEnv) {
  return {
    handler(e: MouseEvent, uri: string): void {
      perform(env, linkAction("url", e, env.settings(), env.mac), e, urlRun(env, uri));
    },
    hover: (_e: MouseEvent, text: string): void => env.tip(hint(env, "url", text)),
    leave: (): void => env.tip(null),
  };
}

export type OscTarget = { kind: "url"; url: string } | { kind: "file"; path: string; line?: number; column?: number };

/**
 * What an OSC 8 target names: an http(s) URL; a `file://` URI of this machine (host empty or
 * `localhost`) or a bare path, with `:line:col` read from the text and a `#L12` fragment dropped;
 * anything else (another scheme, another host) is null.
 */
export function parseOscTarget(raw: string): OscTarget | null {
  const text = raw.trim();
  if (/^https?:\/\//i.test(text)) return { kind: "url", url: text };
  const hash = text.indexOf("#");
  const body = hash === -1 ? text : text.slice(0, hash);
  if (/^file:/i.test(body)) {
    if (!/^file:\/\/(localhost)?\//i.test(body)) return null;
  } else if (/^[A-Za-z][A-Za-z0-9+.-]+:(?!\d+(:\d+)?$)/.test(body)) {
    // `mailto:`, `ssh:` and the like; `a.ts:12` is a path with a line.
    return null;
  }
  const at = parseLocation(body);
  if (!at) return null;
  return { kind: "file", path: at.path, ...(at.line !== undefined ? { line: at.line } : {}), ...(at.column !== undefined ? { column: at.column } : {}) };
}

/** xterm's `linkHandler` for OSC 8: a plain left click as the setting says, or Mod+click. */
export function createOscLinkHandler(env: TermLinksEnv): ILinkHandler {
  return {
    allowNonHttpProtocols: true,
    activate(e, text) {
      if (e.button !== 0) return;
      const target = parseOscTarget(text);
      if (!target) return;
      if (target.kind === "url") return perform(env, linkAction("url", e, env.settings(), env.mac), e, urlRun(env, target.url));
      const action = linkAction("file", e, env.settings(), env.mac);
      const worktree = env.worktree();
      if (action === "none" || !worktree) return;
      void env.resolve(worktree, [target.path], env.cwd?.()).then(
        ([rel]) => {
          if (!rel) return;
          const file: FileTarget = { worktree, rel, ...(target.line !== undefined ? { line: target.line } : {}), ...(target.column !== undefined ? { column: target.column } : {}) };
          perform(env, action, e, fileRun(env, file, text));
        },
        () => {},
      );
    },
    hover(_e, text) {
      const target = parseOscTarget(text);
      if (target) env.tip(hint(env, target.kind, text));
    },
    leave: () => env.tip(null),
  };
}
