// The text the copy actions of a search result put on the clipboard, as plain functions.

/** `\` becomes `/`; a Windows path reads the same in a ticket on any system. */
const slashes = (path: string): string => path.replace(/\\/g, "/");

/** The path relative to the worktree root, with forward slashes and no leading `./`. */
export function relativePath(rel: string): string {
  return slashes(rel).replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

/** The absolute path: the worktree root and the relative path, joined with the root's own separator. */
export function absolutePath(worktree: string, rel: string): string {
  const sep = worktree.includes("\\") && !worktree.includes("/") ? "\\" : "/";
  const root = worktree.replace(/[\\/]+$/, "");
  const tail = relativePath(rel);
  return `${root}${sep}${sep === "\\" ? tail.replace(/\//g, "\\") : tail}`;
}

/** `relative/path#L<line>` for a 1-based line. */
export function pathWithLine(rel: string, line: number): string {
  return `${relativePath(rel)}#L${line}`;
}
