import type { JSX } from "react";
import { Icon, Spinner } from "@xdev-asia/ui";
import type { TabStatus } from "./status";
import { StatusGlyph } from "./StatusGlyph";

/**
 * The state mark of a tab: the library spinner while the agent works, a question icon when it
 * needs the person, the status dot (or check, ring) otherwise. `null` (a plain shell) draws nothing.
 */
export function TabIndicator({ status, label }: { status: TabStatus | null; label: string }): JSX.Element | null {
  if (status === "working") {
    return (
      <span className="ws-tab-ind" data-status="working" title={label}>
        <Spinner size="sm" label={label} />
      </span>
    );
  }
  if (status === "needs-you") {
    return (
      <span className="ws-tab-ind" data-status="needs-you" role="img" aria-label={label} title={label}>
        <Icon name="help" size={12} />
      </span>
    );
  }
  return StatusGlyph({ status, label });
}
