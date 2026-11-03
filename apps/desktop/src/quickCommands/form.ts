import { toApiError, type Api, type QuickCommand } from "@/api";
import { QUICK_COMMAND_LIMITS } from "./limits";

/** What the edit dialog holds. Both kinds keep their fields, so switching Type loses nothing. */
export interface Draft {
  label: string;
  scope: "global" | "repo";
  repo: string;
  type: "terminal" | "agent";
  command: string;
  appendEnter: boolean;
  profile: string;
  prompt: string;
}

export type Field = "label" | "repo" | "command" | "prompt" | "profile" | "prompts";

/** A new draft: a terminal command that types Enter; `repo` is the repo on screen (null: global). */
export function emptyDraft(repo: string | null, profile: string): Draft {
  return {
    label: "",
    scope: repo === null ? "global" : "repo",
    repo: repo ?? "",
    type: "terminal",
    command: "",
    appendEnter: true,
    profile,
    prompt: "",
  };
}

export function draftOf(cmd: QuickCommand, fallbackProfile: string): Draft {
  const base = emptyDraft(null, fallbackProfile);
  const scope = cmd.scope.type === "repo" ? { scope: "repo" as const, repo: cmd.scope.repo } : { scope: "global" as const, repo: "" };
  const action =
    cmd.action.type === "terminal"
      ? { type: "terminal" as const, command: cmd.action.command, appendEnter: cmd.action.appendEnter }
      : { type: "agent" as const, profile: cmd.action.profile, prompt: cmd.action.prompt };
  return { ...base, label: cmd.label, ...scope, ...action };
}

export const withType = (d: Draft, type: Draft["type"]): Draft => ({ ...d, type });

/** The command to store; an empty `id` asks the store for a new one. */
export function toCommand(d: Draft, id: string): QuickCommand {
  return {
    id,
    label: d.label.trim(),
    scope: d.scope === "repo" ? { type: "repo", repo: d.repo } : { type: "global" },
    action:
      d.type === "terminal"
        ? { type: "terminal", command: d.command.trimEnd(), appendEnter: d.appendEnter }
        : { type: "agent", profile: d.profile, prompt: d.prompt },
  };
}

const FIELDS: readonly Field[] = ["label", "repo", "command", "prompt", "profile", "prompts"];

/** The field a `bad_arg` names in its detail, or null. */
export function fieldOfError(e: unknown): Field | null {
  const err = toApiError(e);
  return err.code === "bad_arg" && FIELDS.includes(err.detail as Field) ? (err.detail as Field) : null;
}

export type SaveResult = { ok: true; saved: QuickCommand } | { ok: false; field: Field | null; code: string };

/** Saves a draft; a refusal comes back as the field it is about, to show under that field. */
export async function saveDraft(api: Pick<Api, "quickCommandUpsert">, d: Draft, id: string): Promise<SaveResult> {
  try {
    return { ok: true, saved: await api.quickCommandUpsert(toCommand(d, id)) };
  } catch (e) {
    return { ok: false, field: fieldOfError(e), code: toApiError(e).code };
  }
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

export interface Counter {
  field: "label" | "command" | "prompt";
  used: number;
  max: number;
  /** In bytes (the prompt), else in characters. */
  bytes: boolean;
}

/** The counter of a field, shown only from 80% of its limit on (and past it). */
export function counterOf(d: Draft, field: Counter["field"]): Counter | null {
  const c: Counter =
    field === "label"
      ? { field, used: [...d.label.trim()].length, max: QUICK_COMMAND_LIMITS.label, bytes: false }
      : field === "command"
        ? { field, used: [...d.command.trimEnd()].length, max: QUICK_COMMAND_LIMITS.command, bytes: false }
        : { field, used: bytes(d.prompt), max: QUICK_COMMAND_LIMITS.promptBytes, bytes: true };
  return c.used >= c.max * 0.8 ? c : null;
}

/** Whether Save is worth trying: the fields a person must fill are not empty. */
export function canSave(d: Draft): boolean {
  if (d.label.trim() === "") return false;
  if (d.scope === "repo" && d.repo === "") return false;
  return d.type === "terminal" ? d.command.trim() !== "" : d.profile !== "" && d.prompt.trim() !== "";
}

/** A copy of a command: no id, the label marked, cut to the label limit. */
export function duplicateOf(cmd: QuickCommand, suffix: string): QuickCommand {
  const room = QUICK_COMMAND_LIMITS.label - [...suffix].length;
  return { ...cmd, id: "", label: [...cmd.label].slice(0, room).join("") + suffix };
}
