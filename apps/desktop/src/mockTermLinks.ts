import type { Api, ApiError } from "./api";

type TermLinksApi = Pick<Api, "fileLinksResolve" | "fileOpenDefault" | "openUrl" | "fileRemoteUrl">;

export type MockTermLinks = TermLinksApi & {
  // Every `openUrl` that was accepted, oldest first.
  __openedUrls(): string[];
  // Every `fileOpenDefault` that was accepted, oldest first.
  __defaultOpens(): { worktree: string; rel: string }[];
};

/** `links_open.rs` limits. */
export const LINK_LIMITS = { paths: 64, path: 4096, url: 2048 } as const;

// Windows extensions that can run as a program; compared case-insensitively.
const RUNNABLE = /\.(exe|com|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|msi|msc|scr|lnk|pif|cpl|hta|reg)$/i;

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const err: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(err);
}

function stripEnd(path: string): string {
  return path.replace(/\/+$/, "");
}

/** The worktree-relative path `text` names, or null: a plain `rel`, an absolute path under `root`, or `file://`. */
function relOf(root: string, text: string): string | null {
  let t = text;
  if (/^file:\/\//i.test(t)) {
    try {
      t = decodeURIComponent(t.replace(/^file:\/\/(localhost)?/i, ""));
    } catch {
      return null;
    }
  }
  t = t.replace(/\\/g, "/");
  const base = stripEnd(root.replace(/\\/g, "/"));
  if (t.startsWith("/") || /^[A-Za-z]:\//.test(t)) {
    if (!t.startsWith(`${base}/`)) return null;
    t = t.slice(base.length + 1);
  }
  const out: string[] = [];
  for (const part of t.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.pop() === undefined) return null;
      continue;
    }
    out.push(part);
  }
  if (out.length === 0 || out.some((p) => p.toLowerCase() === ".git")) return null;
  return out.join("/");
}

/**
 * Terminal links in memory: a candidate resolves when it names a file in the worktree's listing,
 * a default-app open and a URL open are recorded, and the hosted URL is a GitHub one.
 */
export function createMockTermLinks(filesList: Api["filesList"]): MockTermLinks {
  const urls: string[] = [];
  const opens: { worktree: string; rel: string }[] = [];
  return {
    async fileLinksResolve(worktree, paths) {
      if (paths.length > LINK_LIMITS.paths || paths.some((p) => p.length > LINK_LIMITS.path)) return reject("bad_arg", "paths");
      const files = new Set((await filesList(worktree)).files);
      return paths.map((p) => {
        const rel = relOf(worktree, p);
        return rel !== null && files.has(rel) ? rel : null;
      });
    },
    async fileOpenDefault(worktree, rel) {
      const files = new Set((await filesList(worktree)).files);
      const clean = relOf(worktree, rel);
      if (clean === null || /^[A-Za-z]:|^\//.test(rel)) return reject("bad_path", rel);
      if (!files.has(clean)) return reject("not_found", rel);
      if (RUNNABLE.test(clean)) return reject("denied", rel);
      opens.push({ worktree, rel: clean });
    },
    async openUrl(url) {
      const ok = /^https?:\/\/[^\s\u0000-\u001f\u007f]+$/i.test(url) && new TextEncoder().encode(url).length <= LINK_LIMITS.url;
      if (!ok) return reject("bad_arg", "url");
      urls.push(url);
    },
    async fileRemoteUrl(worktree, rel, line, endLine) {
      const clean = relOf(worktree, rel);
      if (clean === null) return reject("bad_path", rel);
      const to = endLine !== null && endLine > line ? `-L${endLine}` : "";
      return `https://github.com/xdev-asia/demo/blob/main/${clean.split("/").map(encodeURIComponent).join("/")}#L${line}${to}`;
    },
    __openedUrls: () => [...urls],
    __defaultOpens: () => structuredClone(opens),
  };
}
