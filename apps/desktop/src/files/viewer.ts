import type { FileKind } from "@/api";

/** Which view a file opens in. */
export type Viewer = "markdown" | "csv" | "notebook" | "image" | "media" | "pdf" | "text" | "binary";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  pdf: "application/pdf",
};
const AUDIO = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac"]);
const VIDEO = new Set(["mp4", "webm", "ogv", "mov"]);
const MARKDOWN = new Set(["md", "markdown"]);
const CSV = new Set(["csv", "tsv", "tab"]);

function extOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * The view for `rel`. `kind` is what the text read said; leave it out before the file is read.
 * Images and media never need that read, so they answer without it. Svg is text on disk: it is an
 * image once a read says it is not too large, and "text" (read it first) until then. A table or a
 * notebook is text on disk too: it has its view only once the read found text.
 */
export function viewerOf(rel: string, kind?: FileKind): Viewer {
  const ext = extOf(rel);
  if (ext === "svg") return kind === undefined || kind === "tooLarge" ? "text" : "image";
  if (ext === "pdf") return "pdf";
  if (AUDIO.has(ext) || VIDEO.has(ext)) return "media";
  if (ext in MIME) return "image";
  if (kind === "binary") return "binary";
  if (kind === "text" && CSV.has(ext)) return "csv";
  if (kind === "text" && ext === "ipynb") return "notebook";
  return MARKDOWN.has(ext) ? "markdown" : "text";
}

/** The blob type for `rel`'s extension. */
export function mimeOf(rel: string): string {
  return MIME[extOf(rel)] ?? "application/octet-stream";
}

/** "512 B", "1.5 KB", "2.0 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
