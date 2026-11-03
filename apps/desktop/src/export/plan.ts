import type { Expected, ExportFile, ExportPlan, Target } from "@/api";

// Codex's default limit for project docs; past it, agents may read only part of AGENTS.md.
export const AGENTS_LIMIT_BYTES = 32 * 1024;

const FILE_TARGET: Record<string, Target> = {
  "AGENTS.md": "agents",
  "CLAUDE.md": "claude",
  "GEMINI.md": "gemini",
  ".cursor/rules/xdev.mdc": "cursor",
};

/** Files a write would touch: unchanged ones need nothing and foreign ones are never overwritten. */
export function writable(plan: ExportPlan): ExportFile[] {
  return plan.files.filter((f) => f.status === "new" || f.status === "changed");
}

/** What the user has seen, so the write can refuse if the docs moved on since. */
export function expectedOf(plan: ExportPlan): Expected[] {
  return writable(plan).map((f) => ({ path: f.path, hash: f.hash }));
}

/** Docs whose sections end up in `path`. */
export function docsFor(plan: ExportPlan, path: string): ExportPlan["docs"] {
  const target = FILE_TARGET[path];
  return target === undefined ? [] : plan.docs.filter((d) => d.targets.includes(target));
}

export function overLimit(file: ExportFile): boolean {
  return new TextEncoder().encode(file.new).length > AGENTS_LIMIT_BYTES;
}
