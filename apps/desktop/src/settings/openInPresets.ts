// The editors the Open In page offers with one click, and whether the user's list has them already.

import type { OpenInApp } from "@/api";

export const OPEN_IN_PRESETS: OpenInApp[] = [
  { id: "vscode", label: "VS Code", command: "code", args: [] },
  { id: "cursor", label: "Cursor", command: "cursor", args: [] },
  { id: "zed", label: "Zed", command: "zed", args: [] },
  { id: "windsurf", label: "Windsurf", command: "windsurf", args: [] },
];

/** A preset counts as added when an app in the list starts the same program. */
export function isPresetAdded(apps: OpenInApp[], preset: OpenInApp): boolean {
  return apps.some((a) => a.command.trim() === preset.command);
}

/** The list entry for `preset`: its own id when free, else the first free `app-N`. */
export function presetEntry(apps: OpenInApp[], preset: OpenInApp): OpenInApp {
  const used = new Set(apps.map((a) => a.id));
  let id = preset.id;
  for (let n = 1; used.has(id); n++) id = `app-${n}`;
  return { ...preset, id, args: [...preset.args] };
}
