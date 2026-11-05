import type { Note } from "@/api";
import { pastePrompt } from "@/workspace/agentPrompt";

/** The most bytes of a note, as stored in Rust. */
export const NOTE_BODY_MAX = 64 * 1024;

const encoder = new TextEncoder();

/** UTF-8 bytes of `text`, the unit of the 64 KB bound. */
export const byteLength = (text: string): number => encoder.encode(text).length;

export const tooLong = (body: string): boolean => byteLength(body) > NOTE_BODY_MAX;

/** A note shows (a dot, a filled button) only when it holds more than blanks. */
export const hasText = (note: Pick<Note, "body"> | null | undefined): boolean => !!note && note.body.trim() !== "";

/** What the library lists for `query`: notes whose body, tab title or worktree holds every word, newest first. */
export function searchNotes(notes: readonly Note[], query: string): Note[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return notes
    .filter((n) => {
      const hay = `${n.body}\n${n.title}\n${n.worktree}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The first non-blank line, without Markdown heading and list marks, cut to `max` characters. */
export function snippet(body: string, max = 120): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  const plain = line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+)/, "").trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/**
 * The bytes that type a note into a terminal: one bracketed paste with no Enter, so the person reads it and
 * presses Enter themselves. Control characters are dropped, as for a prompt.
 */
export const pasteNote = (body: string): string => pastePrompt(body.trimEnd()).replace(/\r$/, "");
