import type { Api } from "@/api";
import type { Link } from "@/doc/links";
import { mimeOf } from "./viewer";

/** `src` joined to the folder of `from`, without `.` and `..`; null when it leaves the worktree. */
export function joinRel(from: string, target: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length === 0 ? null : parts.join("/");
}

/** Resolves a link in a worktree file: a relative `.md` link is a path next to the file; `[[wiki]]` links are not files. */
export function resolveFileLink(link: Link, from: string): string | null {
  if (link.kind === "wiki") return null;
  const target = link.target.startsWith("/") ? link.target.slice(1) : link.target;
  return joinRel(link.target.startsWith("/") ? "x" : from, target);
}

/** A relative image `src`: no scheme, not protocol-relative, not an anchor. */
export function isRelativeSrc(src: string): boolean {
  return src !== "" && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src) && !src.startsWith("//") && !src.startsWith("#");
}

export interface ImageHost {
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null; replaceWith(node: unknown): void }>;
}
export interface FillIo {
  api: Pick<Api, "fileBytes">;
  worktree: string;
  rel: string;
  /** Builds the `<img>`; the default uses the page. */
  make?: (url: string, alt: string) => unknown;
  urls?: { create(blob: Blob): string; revoke(url: string): void };
}

const defaultMake = (url: string, alt: string): unknown => {
  const img = document.createElement("img");
  img.src = url;
  img.alt = alt;
  img.className = "md-img";
  return img;
};
const defaultUrls = { create: (b: Blob) => URL.createObjectURL(b), revoke: (u: string) => URL.revokeObjectURL(u) };

/**
 * Reads each relative image through the backend and swaps it in for its placeholder. Remote
 * images are never fetched. Returns the cleanup, which revokes the object URLs.
 */
export function fillImages(root: ImageHost, io: FillIo): () => void {
  const urls = io.urls ?? defaultUrls;
  const made: string[] = [];
  let live = true;
  for (const el of Array.from(root.querySelectorAll(".md-image[data-src]"))) {
    const src = el.getAttribute("data-src") ?? "";
    const rel = isRelativeSrc(src) ? joinRel(io.rel, safeDecode(src.split(/[?#]/)[0])) : null;
    if (rel === null) continue;
    void io.api.fileBytes(io.worktree, rel).then(
      (bytes) => {
        if (!live) return;
        const url = urls.create(new Blob([bytes as BlobPart], { type: mimeOf(rel) }));
        made.push(url);
        el.replaceWith((io.make ?? defaultMake)(url, el.getAttribute("data-alt") ?? ""));
      },
      () => undefined,
    );
  }
  return () => {
    live = false;
    made.forEach((u) => urls.revoke(u));
  };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
