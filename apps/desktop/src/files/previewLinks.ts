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

/** The worktree path of an image `src` in the file `from`: a leading `/` starts at the worktree root, like a link. */
function imagePath(from: string, src: string): string | null {
  return src.startsWith("/") ? joinRel("x", src.slice(1)) : joinRel(from, src);
}

/** A relative image `src`: no scheme, not protocol-relative, not an anchor. */
export function isRelativeSrc(src: string): boolean {
  return src !== "" && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src) && !src.startsWith("//") && !src.startsWith("#");
}

export interface ImageHost {
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null; replaceWith(node: unknown): void }>;
}
export interface UrlApi {
  create(blob: Blob): string;
  revoke(url: string): void;
}
export interface FillIo {
  api: Pick<Api, "fileBytes">;
  worktree: string;
  rel: string;
  /** Builds the `<img>`; the default uses the page. */
  make?: (url: string, alt: string) => unknown;
  urls?: UrlApi;
  /** Where the images are read and kept. Without one, `fillImages` makes its own and its cleanup disposes it. */
  cache?: ImageCache;
}

const defaultMake = (url: string, alt: string): unknown => {
  const img = document.createElement("img");
  img.src = url;
  img.alt = alt;
  img.className = "md-img";
  return img;
};
const defaultUrls: UrlApi = { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) };

/** Most image reads in flight at once, so a document of many images does not flood the backend. */
export const MAX_IMAGE_READS = 4;

/**
 * The object URL of each image path of one worktree, read through the backend once however many
 * times it is asked for, with at most {@link MAX_IMAGE_READS} reads at a time. It owns the URLs:
 * `dispose` revokes them (call it when the preview goes away). A failed read is not remembered.
 */
export class ImageCache {
  private byPath = new Map<string, Promise<string>>();
  private made: string[] = [];
  private queue: Array<{ start: () => void; stop: (e: unknown) => void }> = [];
  private active = 0;
  private gen = 0;
  constructor(
    private api: Pick<Api, "fileBytes">,
    private worktree: string,
    private urls: UrlApi = defaultUrls,
    private limit = MAX_IMAGE_READS,
  ) {}

  url(rel: string): Promise<string> {
    let found = this.byPath.get(rel);
    if (!found) {
      const pending = this.read(rel);
      found = pending;
      this.byPath.set(rel, pending);
      pending.catch(() => {
        if (this.byPath.get(rel) === pending) this.byPath.delete(rel);
      });
    }
    return found;
  }

  private read(rel: string): Promise<string> {
    const gen = this.gen;
    return new Promise<string>((resolve, reject) => {
      const start = (): void => {
        this.active++;
        this.api
          .fileBytes(this.worktree, rel)
          .then(
            (bytes) => {
              if (gen !== this.gen) return reject(new Error("image cache disposed"));
              const url = this.urls.create(new Blob([bytes as BlobPart], { type: mimeOf(rel) }));
              this.made.push(url);
              resolve(url);
            },
            reject,
          )
          .finally(() => {
            this.active--;
            this.queue.shift()?.start();
          });
      };
      if (this.active < this.limit) start();
      else this.queue.push({ start, stop: reject });
    });
  }

  /** Revokes every URL and drops what is queued or in flight. The cache can be used again. */
  dispose(): void {
    this.gen++;
    this.made.forEach((u) => this.urls.revoke(u));
    this.made = [];
    this.byPath.clear();
    const queued = this.queue;
    this.queue = [];
    queued.forEach((q) => q.stop(new Error("image cache disposed")));
  }
}

/**
 * Swaps each relative image placeholder of `root` for its image, read through the cache. Remote
 * images are never fetched. The cleanup stops swapping; the cache keeps the URLs until it is disposed.
 */
export function fillImages(root: ImageHost, io: FillIo): () => void {
  const own = io.cache ? null : new ImageCache(io.api, io.worktree, io.urls);
  const cache = io.cache ?? own!;
  let live = true;
  for (const el of Array.from(root.querySelectorAll(".md-image[data-src]"))) {
    const src = el.getAttribute("data-src") ?? "";
    const rel = isRelativeSrc(src) ? imagePath(io.rel, safeDecode(src.split(/[?#]/)[0])) : null;
    if (rel === null) continue;
    cache.url(rel).then(
      (url) => {
        if (live) el.replaceWith((io.make ?? defaultMake)(url, el.getAttribute("data-alt") ?? ""));
      },
      () => undefined,
    );
  }
  return () => {
    live = false;
    own?.dispose();
  };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
