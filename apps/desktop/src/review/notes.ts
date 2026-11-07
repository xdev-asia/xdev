import type { ReviewNote } from "@/api";

export const MAX_ANCHOR = 4000;
export const MAX_BODY = 20_000;

let counter = 0;

function freshId(now: number): string {
  counter += 1;
  return `n${now.toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const EOL = /\r\n?|\n/;

/**
 * The anchor is what is stored to find a note again: the first lines of the range that fit in
 * MAX_ANCHOR characters (line ends are always LF, so a CRLF file matches too). A range too big for
 * that keeps only its leading lines, and `place` matches on those and takes the end from the
 * note's own line span. A single line longer than MAX_ANCHOR is cut, and matched by prefix.
 */
export function boundAnchor(text: string): string {
  const lines = text.split(EOL);
  const kept: string[] = [];
  let size = 0;
  for (const l of lines) {
    const add = l.length + (kept.length > 0 ? 1 : 0);
    if (size + add > MAX_ANCHOR) break;
    kept.push(l);
    size += add;
  }
  if (kept.length === 0) return lines[0].slice(0, MAX_ANCHOR);
  return kept.join("\n");
}

/** A note on lines `startLine..line` of `file`; `text` is what those lines say now. */
export function newNote(file: string, startLine: number, line: number, text: string, body: string, now: number, id?: string): ReviewNote {
  return {
    id: id ?? freshId(now),
    file,
    startLine,
    line,
    anchor: boundAnchor(text),
    body: body.trim().slice(0, MAX_BODY),
    createdAt: now,
    sentAt: null,
    outdated: false,
  };
}

/** A new body has not been sent in this form. */
export function editNote(note: ReviewNote, body: string): ReviewNote {
  return { ...note, body: body.trim().slice(0, MAX_BODY), sentAt: null };
}

export function deleteNote(notes: ReviewNote[], id: string): ReviewNote[] {
  return notes.filter((n) => n.id !== id);
}

export function markSent(notes: ReviewNote[], ids: string[], now: number): ReviewNote[] {
  const set = new Set(ids);
  return notes.map((n) => (set.has(n.id) ? { ...n, sentAt: now } : n));
}

/** Every note, or only the ones not sent yet. */
export function notesToSend(notes: ReviewNote[], includeSent: boolean): ReviewNote[] {
  return sortNotes(includeSent ? notes : notes.filter((n) => n.sentAt === null));
}

/** File order, then by line. */
export function sortNotes(notes: ReviewNote[]): ReviewNote[] {
  return [...notes].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine || a.line - b.line || a.createdAt - b.createdAt));
}

function linesOf(text: string): string[] {
  const lines = text.split(EOL);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Re-anchors the notes of `file` against its new text (`null`: the file is gone). A note whose lines
 * still match stays; else it moves to the nearest exact copy of its lines; else it keeps its numbers
 * and is marked `outdated`. Notes of other files are untouched.
 */
export function reanchor(notes: ReviewNote[], file: string, text: string | null): { notes: ReviewNote[]; changed: boolean } {
  const lines = text === null ? null : linesOf(text);
  let changed = false;
  const out = notes.map((n) => {
    if (n.file !== file) return n;
    const next = place(n, lines);
    if (next.startLine === n.startLine && next.line === n.line && next.outdated === n.outdated) return n;
    changed = true;
    return next;
  });
  return { notes: changed ? out : notes, changed };
}

function place(n: ReviewNote, lines: string[] | null): ReviewNote {
  if (lines === null) return { ...n, outdated: true };
  const want = n.anchor.split(EOL);
  const span = Math.max(n.line - n.startLine + 1, want.length);
  // The anchor holds only the leading lines of a big range; its last line may itself be cut.
  const partial = want.length < span || n.anchor.length >= MAX_ANCHOR;
  const same = (got: string | undefined, l: string, i: number) => (partial && i === want.length - 1 ? got?.startsWith(l) === true : got === l);
  const at = (p: number) => want.every((l, i) => same(lines[p - 1 + i], l, i));
  const fits = (p: number) => p >= 1 && p - 1 + span <= lines.length;
  if (fits(n.startLine) && at(n.startLine)) return { ...n, outdated: false };
  let best: number | null = null;
  for (let p = 1; fits(p); p++) {
    if (!at(p)) continue;
    if (best === null || Math.abs(p - n.startLine) < Math.abs(best - n.startLine)) best = p;
  }
  if (best !== null) return { ...n, startLine: best, line: best + span - 1, outdated: false };
  const last = Math.max(lines.length, 1);
  const startLine = Math.min(n.startLine, last);
  return { ...n, startLine, line: Math.max(startLine, Math.min(n.line, last)), outdated: true };
}

/** The verdict a review ends with; there is no PR review to submit, so it shapes what the agent is asked to do. */
export type Verdict = "changes" | "comment" | "approve";

const ASK: Record<Verdict, string> = {
  changes: "Fix each point, re-run the tests, then report back:",
  comment: "Consider each point and reply; change the code only where you agree, then report back:",
  approve: "The change is approved. The points below are optional; take them only if they are quick, then report back:",
};
const NONE: Record<Verdict, string> = {
  changes: "changes requested. Make the changes below, re-run the tests, then report back.",
  comment: "a comment. Reply to it; change the code only where you agree.",
  approve: "approved. Nothing to change.",
};

/** The prompt that goes to the agent, one item per note. */
export function notesPrompt(branch: string | null, notes: ReviewNote[]): string {
  return reviewPrompt(branch, notes, "changes", "");
}

/** The prompt of a whole review: the verdict, the summary when there is one, then one item per note. */
export function reviewPrompt(branch: string | null, notes: ReviewNote[], verdict: Verdict, summary: string): string {
  const name = branch ?? "HEAD (detached)";
  const text = summary.trim();
  if (notes.length === 0) return `Review of ${name}: ${NONE[verdict]}${text ? `\n\n${text}` : ""}`;
  const items = sortNotes(notes).map((n, i) => {
    const where = n.startLine === n.line ? `${n.line}` : `${n.startLine}-${n.line}`;
    const body = n.body.trim().split("\n").join("\n   ");
    const flag = n.outdated ? " (outdated: the line changed after this note)" : "";
    return `${i + 1}. ${n.file}:${where} — ${body}${flag}`;
  });
  const head = text ? `Review notes for ${name}.\n\n${text}\n\n${ASK[verdict]}` : `Review notes for ${name}. ${ASK[verdict]}`;
  return `${head}\n\n${items.join("\n")}`;
}
