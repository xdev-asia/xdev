import type { ImportPreview, SectionPreview } from "@/api";

/** The sections a settings file can carry, as `settings.json` names them; each has `settings.config.section.<name>`. */
export const CONFIG_SECTIONS = [
  "git",
  "status",
  "terminal",
  "keys",
  "ui",
  "quickCommands",
  "openIn",
  "editor",
  "sidebar",
  "navigation",
  "diff",
  "agents",
  "usage",
  "orchestration",
  "shell",
  "automations",
  "network",
] as const;

export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

/** A section the import can apply: it is valid and changes something. */
export function applicable(s: SectionPreview): boolean {
  return !s.invalid && s.changes.length > 0;
}

/** The sections ticked when a preview opens: every one that can be applied. */
export function defaultChosen(preview: ImportPreview): string[] {
  return preview.sections.filter(applicable).map((s) => s.section);
}

/** `chosen` with `name` switched on or off, in the order the preview lists them. */
export function toggle(preview: ImportPreview, chosen: readonly string[], name: string): string[] {
  const on = new Set(chosen);
  if (on.has(name)) on.delete(name);
  else on.add(name);
  return preview.sections.filter((s) => on.has(s.section) && applicable(s)).map((s) => s.section);
}

/** Whether the file would change nothing at all. */
export function nothingToImport(preview: ImportPreview): boolean {
  return !preview.sections.some(applicable);
}

/** The base name of a path, either separator. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** What the open dialog offers for an import. */
export const CONFIG_EXTENSIONS = ["json", "xdev.json"];
