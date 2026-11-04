import type { ConflictState } from "@/api";

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
