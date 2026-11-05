import type { SparsePreset } from "@/api";

/** Most presets a repo keeps, as `SPARSE_PRESETS_MAX` in the desktop. */
export const SPARSE_PRESETS_MAX = 20;
/** Longest preset name in characters, as `SPARSE_PRESET_NAME_MAX`. */
export const SPARSE_PRESET_NAME_MAX = 60;

/** The trimmed name when it is one a preset can have, else null. */
export function presetName(name: string): string | null {
  const n = name.trim();
  // eslint-disable-next-line no-control-regex
  return n === "" || [...n].length > SPARSE_PRESET_NAME_MAX || /[\u0000-\u001f\u007f]/.test(n) ? null : n;
}

/** One preset per name, as the desktop keeps them: a later preset replaces an earlier one and moves last. */
export function dedupePresets(presets: SparsePreset[]): SparsePreset[] {
  const out: SparsePreset[] = [];
  for (const p of presets) {
    const name = p.name.trim();
    const at = out.findIndex((o) => o.name === name);
    if (at >= 0) out.splice(at, 1);
    out.push({ name, dirs: [...p.dirs] });
  }
  return out;
}

/**
 * The list with `name` set to `dirs`, replacing a preset of that name; "bad" for an unusable name, no
 * folders, or a new name past `SPARSE_PRESETS_MAX`.
 */
export function addPreset(presets: SparsePreset[], name: string, dirs: string[]): SparsePreset[] | "bad" {
  const n = presetName(name);
  if (n === null || dirs.length === 0) return "bad";
  const next = dedupePresets([...presets, { name: n, dirs }]);
  return next.length > SPARSE_PRESETS_MAX ? "bad" : next;
}

/** The list without the preset named `name`. */
export function removePreset(presets: SparsePreset[], name: string): SparsePreset[] {
  return presets.filter((p) => p.name !== name);
}

/** The folders as the sparse field shows them, one per line. */
export function presetText(preset: SparsePreset): string {
  return preset.dirs.join("\n");
}
