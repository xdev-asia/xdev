import type { LaunchOverrides } from "@/api";
import { splitShellWords } from "./shellWords";

/** The model choice value that means "type a name". */
export const CUSTOM_MODEL = "__custom";

export type OptionsForm = {
  /** "" for the profile default, a known model, or `CUSTOM_MODEL`. */
  model: string;
  /** The name typed when `model` is `CUSTOM_MODEL`. */
  customModel: string;
  /** "" for the profile default. */
  effort: string;
  args: string;
};

export const EMPTY_FORM: OptionsForm = { model: "", customModel: "", effort: "", args: "" };

/**
 * The overrides a form stands for, or null when it changes nothing; `badArgs` when the extra arguments
 * have an open quote. Effort is dropped for an agent with none.
 */
export function buildOverrides(form: OptionsForm, hasEffort: boolean): { overrides: LaunchOverrides | null; badArgs: boolean } {
  const split = splitShellWords(form.args);
  const model = (form.model === CUSTOM_MODEL ? form.customModel : form.model).trim();
  const effort = hasEffort ? form.effort.trim() : "";
  const overrides: LaunchOverrides = { model: model || null, effort: effort || null, extraArgs: split.error ? [] : split.words };
  const empty = !overrides.model && !overrides.effort && overrides.extraArgs.length === 0;
  return { overrides: empty ? null : overrides, badArgs: split.error !== null };
}
