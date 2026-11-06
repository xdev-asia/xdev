import type { TaskDraft } from "@/api";

export type CaptureSource =
  | { kind: "file"; file: string; from: number; to: number }
  | { kind: "terminal"; tabTitle: string };

export const TITLE_MAX = 80;

/** The first non-empty line, trimmed and cut at 80 characters; "" when the text has none. */
export function titleOf(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return Array.from(line.trim()).slice(0, TITLE_MAX).join("");
}

/** A fence longer than any run of backticks in `text` (at least three). */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return "`".repeat(Math.max(3, longest + 1));
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** "From terminal claude" or "From src/a.ts, lines 3–9", in the person's language. */
export function sourceLine(source: CaptureSource, t: T): string {
  return source.kind === "file"
    ? t("board.capture.from.file", { file: source.file, from: source.from, to: source.to })
    : t("board.capture.from.terminal", { tab: source.tabTitle });
}

/**
 * A draft from selected text: the title is its first line, the body names where it came from
 * and holds the text in a fenced block. `t` translates the source line.
 */
export function draftFromSelection(args: { text: string; source: CaptureSource }, t: T): TaskDraft {
  const line = sourceLine(args.source, t);
  const text = args.text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (text.trim() === "") return { title: "", labels: [], body: `${line}\n` };
  const fence = fenceFor(text);
  return { title: titleOf(text), labels: [], body: `${line}\n\n${fence}\n${text}\n${fence}\n` };
}
