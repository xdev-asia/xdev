// The reasons a new or renamed entry name is refused before Rust is asked. Rust (`rel_under`) stays
// the authority; this gives the same answers early, in words.
export type NameProblem = "empty" | "slash" | "git" | "trailing" | "reserved" | "exists";

const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * The problem with `name` as one entry in a folder holding `siblings`, or null. Windows treats a
 * device name as reserved with any extension (`nul.txt`).
 */
export function checkName(name: string, siblings: readonly string[]): NameProblem | null {
  if (name.trim() === "") return "empty";
  if (name.includes("/") || name.includes("\\")) return "slash";
  if (name === ".git") return "git";
  if (name.endsWith(".") || name.endsWith(" ")) return "trailing";
  if (DEVICE.test(name.split(".")[0].trimEnd())) return "reserved";
  const lower = name.toLowerCase();
  if (siblings.some((s) => s.toLowerCase() === lower)) return "exists";
  return null;
}
