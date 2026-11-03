import type { JSX } from "react";
import type { TabStatus } from "./status";

// Only these two are characters; the spinner, dots and ring are drawn in CSS.
const TEXT: Partial<Record<TabStatus, string>> = { "needs-you": "?", done: "✓" };

/**
 * The status mark of a tab or worktree row: a spinner while working, `?` when it needs the
 * person, a check when done, a dot when failed or idle, a hollow ring once exited. `null` (a
 * plain shell, or a worktree with no agent) draws nothing. `label` is the translated status;
 * the caller passes it so this stays a plain call that rows and tabs can make in a loop.
 */
export function StatusGlyph({ status, label }: { status: TabStatus | null; label: string }): JSX.Element | null {
  if (status === null) return null;
  return (
    <span className="ws-glyph" data-status={status} role="img" aria-label={label} title={label}>
      {TEXT[status] ?? null}
    </span>
  );
}
