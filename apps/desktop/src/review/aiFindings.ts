import type { ReviewFinding, ReviewNote } from "@/api";

export type AiSeverity = ReviewFinding["severity"];

/** The id of an AI finding that is shown as a note: `ai:<severity>:<n>`. A person's note never has one. */
const PREFIX = "ai:";

export const isAiNote = (note: Pick<ReviewNote, "id">): boolean => note.id.startsWith(PREFIX);

export function aiSeverity(note: Pick<ReviewNote, "id">): AiSeverity {
  const word = note.id.split(":")[1];
  return word === "problem" || word === "warning" ? word : "info";
}

/** A finding on `line` of `file` as a note the existing widgets can draw; it is never saved with the person's notes. */
export function findingNote(file: string, finding: ReviewFinding, seq: number, now: number): ReviewNote {
  return {
    id: `${PREFIX}${finding.severity}:${seq}`,
    file,
    startLine: finding.line,
    line: finding.line,
    anchor: "",
    body: finding.text,
    createdAt: now,
    sentAt: null,
    outdated: false,
  };
}
