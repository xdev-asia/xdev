import type { PathEntry } from "@xdev/bindings";

/** Why an entry of the owner is refused; `agent_path::EntryError` in Rust. */
export type EntryProblem = "empty" | "separator" | "control";

/** The PATH separator of the system the entries are for. */
export function separatorFor(windows: boolean): string {
  return windows ? ";" : ":";
}

/** `validate_entry_with` in Rust: the trimmed entry, or why it cannot be one. */
export function validateEntry(raw: string, sep: string): { ok: string } | { problem: EntryProblem } {
  const entry = raw.trim();
  if (entry === "") return { problem: "empty" };
  if (entry.includes(sep)) return { problem: "separator" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(entry)) return { problem: "control" };
  return { ok: entry };
}

/** `clean_entries` in Rust: the valid entries, trimmed, each once, in order. */
export function cleanEntries(raw: readonly string[], sep: string, windows = sep === ";"): string[] {
  const out: string[] = [];
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const r of raw) {
    const v = validateEntry(r, sep);
    if ("ok" in v && !out.some((o) => same(o, v.ok))) out.push(v.ok);
  }
  return out;
}

/** `layout` in Rust: prepend, system, then append entries; a directory shows once, at its first place. */
export function layoutPath(
  system: readonly string[],
  prepend: readonly string[],
  append: readonly string[],
  exists: (path: string) => boolean,
  windows = false,
): PathEntry[] {
  const out: PathEntry[] = [];
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const add = (path: string, source: PathEntry["source"]) => {
    if (path === "" || out.some((e) => same(e.path, path))) return;
    out.push({ path, source, exists: exists(path) });
  };
  for (const p of prepend) add(p, "prepend");
  for (const p of system) add(p, "system");
  for (const p of append) add(p, "append");
  return out;
}
