import { chordLabel, type ActionId } from "./keymap";

/** A tooltip: the label, then the chord of `action` in parentheses; the label alone when it has none. */
export function withChord(
  t: (key: string, vars?: Record<string, string | number>) => string,
  label: string,
  action: ActionId,
  mac?: boolean,
): string {
  const chord = chordLabel(action, mac);
  return chord === null ? label : t("keys.hint", { label, chord });
}
