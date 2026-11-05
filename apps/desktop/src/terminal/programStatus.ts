import type { TabStatus } from "@/workspace/status";

export type ProgramState = "idle" | "working" | "done" | "blocked" | "error" | "clear";
export type ProgramKind = "permission" | "question" | "auth";

export type ProgramStatusMessage =
  | { type: "query" }
  | { type: "report"; state: ProgramState; kind?: ProgramKind; progress?: number; msg?: string; title?: string; id: string | null };

/** The answer to the `?` probe: what this terminal understands. */
export const PROGRAM_STATUS_REPLY = "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";

/** A body longer than this is ignored. */
export const PROGRAM_STATUS_MAX = 4087;

const STATES: readonly ProgramState[] = ["idle", "working", "done", "blocked", "error", "clear"];
const KINDS: readonly ProgramKind[] = ["permission", "question", "auth"];

function decode(b64: string): string | null {
  try {
    const bin = atob(b64);
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Reads the body of an OSC 7501 sequence (`state=working:progress=40`, or `?`); null when it says nothing usable. */
export function parseProgramStatus(body: string): ProgramStatusMessage | null {
  if (body.length > PROGRAM_STATUS_MAX) return null;
  if (body === "?") return { type: "query" };
  const fields = new Map<string, string>();
  for (const part of body.split(":")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const state = STATES.find((s) => s === fields.get("state"));
  if (!state) return null;
  const out: Extract<ProgramStatusMessage, { type: "report" }> = { type: "report", state, id: fields.get("id") || null };
  const kind = KINDS.find((k) => k === fields.get("kind"));
  if (state === "blocked" && kind) out.kind = kind;
  const raw = fields.get("progress");
  if ((state === "working" || state === "blocked") && raw !== undefined && /^\d{1,3}$/.test(raw)) {
    const n = Number(raw);
    if (n <= 100) out.progress = n;
  }
  const msg = fields.get("msg");
  if (msg) {
    const text = decode(msg);
    if (text !== null) out.msg = text;
  }
  const title = fields.get("title");
  if (title) {
    const text = decode(title);
    if (text !== null) out.title = text;
  }
  return out;
}

/** The tab status a program state says; null for `clear` (no change). */
export function toTabStatus(state: ProgramState, _kind?: ProgramKind): TabStatus | null {
  switch (state) {
    case "working": return "working";
    case "blocked": return "needs-you";
    case "done": return "done";
    case "error": return "failed";
    case "idle": return "idle";
    case "clear": return null;
  }
}
