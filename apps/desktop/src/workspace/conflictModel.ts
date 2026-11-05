import type { ConflictEntry, ConflictKind, ConflictOp, ConflictResolution, ConflictState } from "@/api";

type Say = (key: string, vars?: Record<string, string | number>) => string;

/**
 * The bar's words for the operation in progress: "Rebase 3 of 7 onto main", "Merge of topic". Without
 * what it applies (or, for a rebase, its step) the plain name stands alone.
 */
export function operationText(state: ConflictState, t: Say): string {
  const { op, onto, step } = state;
  if (op === "rebase") {
    return step && onto ? t("conflicts.op.rebase", { step: step[0], total: step[1], onto }) : t("conflicts.op.rebase.plain");
  }
  return onto ? t(`conflicts.op.${op}`, { onto }) : t(`conflicts.op.${op}.plain`);
}

/** What the "Resolve conflicts" recipe's template can name, for the operation in progress. */
export function conflictVars(state: ConflictState, branch: string): Record<string, string> {
  const operation = state.op === "rebase" && state.step ? `rebase (step ${state.step[0]} of ${state.step[1]})` : state.op;
  return { branch, operation, files: state.files.join("\n"), onto: state.onto ?? "" };
}

const HINTS: Record<ConflictKind, string> = {
  both_modified: "conflicts.hint.markers",
  both_added: "conflicts.hint.choose",
  deleted_by_us: "conflicts.hint.restore",
  deleted_by_them: "conflicts.hint.keepOrDelete",
  added_by_us: "conflicts.hint.added",
  added_by_them: "conflicts.hint.added",
  both_deleted: "conflicts.hint.keepOrDelete",
};

const RESOLUTIONS: Record<ConflictResolution, string> = {
  mark_resolved: "conflicts.resolve.mark",
  keep_file: "conflicts.resolve.keepFile",
  keep_deletion: "conflicts.resolve.keepDeletion",
};

/** The label key of what each side did to a conflicted file. */
export function conflictKindKey(kind: ConflictKind): string {
  return `conflicts.kind.${kind}`;
}

/** The one-line hint key: what the person has to decide for this kind. */
export function conflictHintKey(kind: ConflictKind): string {
  return HINTS[kind];
}

/** The button label key of a resolution. */
export function resolutionKey(how: ConflictResolution): string {
  return RESOLUTIONS[how];
}

/** The conflicts group's title key; a cherry-pick or revert is a review. */
export function conflictTitleKey(op: ConflictOp): string {
  if (op === "merge") return "conflicts.title.merge";
  if (op === "rebase") return "conflicts.title.rebase";
  return "conflicts.title.review";
}

/**
 * The resolutions a row offers, the same rule Rust checks: a file not on disk can only be deleted, a
 * file one side deleted is kept or deleted, any other is marked resolved.
 */
export function resolutionsOf(entry: ConflictEntry): ConflictResolution[] {
  if (!entry.present) return ["keep_deletion"];
  if (entry.kind === "deleted_by_us" || entry.kind === "deleted_by_them") return ["keep_file", "keep_deletion"];
  return ["mark_resolved"];
}
