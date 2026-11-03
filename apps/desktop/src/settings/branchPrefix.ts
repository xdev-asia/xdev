import type { GitSettings } from "@/api";

// Mirrors `xdev_workspace::names` (`normalize_prefix`, `prefix_issue`), so Settings → Git can say
// what a create will do before one runs. The Rust side stays the one that decides.

export type PrefixIssue = "control" | "char" | "sequence" | "edge" | "part";

/** Trimmed, without a leading or trailing `/`, and each `//` run cut to one `/`. */
export function normalizePrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

/** Why a normalized prefix cannot start a branch name; `null` when it can. Same order as Rust. */
export function prefixIssue(prefix: string): PrefixIssue | null {
  if ([...prefix].some((c) => c.codePointAt(0)! <= 0x20 || c.codePointAt(0) === 0x7f)) return "control";
  if (/[~^:?*[\\]/.test(prefix)) return "char";
  if (prefix.includes("..") || prefix.includes("@{")) return "sequence";
  if (prefix.startsWith("-") || prefix.endsWith(".")) return "edge";
  if (prefix.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) return "part";
  return null;
}

export type PrefixPreview =
  // New branches are named `<prefix>/<leaf>`.
  | { kind: "prefix"; prefix: string }
  // No prefix: none chosen, nothing typed, or a git username no branch name can hold.
  | { kind: "none" }
  // A custom prefix that creating a worktree refuses.
  | { kind: "invalid"; issue: PrefixIssue };

/** What the next worktree's branch will start with; `userName` is the detected git username. */
export function previewPrefix(git: Pick<GitSettings, "branchPrefix" | "branchPrefixCustom">, userName: string | null): PrefixPreview {
  if (git.branchPrefix === "none") return { kind: "none" };
  const custom = git.branchPrefix === "custom";
  const prefix = normalizePrefix(custom ? git.branchPrefixCustom : (userName ?? ""));
  if (prefix === "") return { kind: "none" };
  const issue = prefixIssue(prefix);
  if (issue === null) return { kind: "prefix", prefix };
  // An unusable git username is skipped silently, as the create does.
  return custom ? { kind: "invalid", issue } : { kind: "none" };
}
