import type { JSX } from "react";
import { Icon, Spinner } from "@xdev-asia/ui";
import type { TabStatus } from "./status";
import { StatusGlyph } from "./StatusGlyph";

/** A progress a program reported, as a whole percent; null when there is none to show. */
export function progressPercent(progress: number | null | undefined): number | null {
  if (typeof progress !== "number" || !Number.isFinite(progress)) return null;
  return Math.round(Math.min(100, Math.max(0, progress)));
}

/**
 * The state mark of a tab: a progress ring while the agent works and a program reported how far it
 * got (OSC 9;4 or 7501), else the library spinner; a question icon when it needs the person, the
 * status dot (or check, ring) otherwise. `null` (a plain shell) draws nothing. `progressLabel` is
 * the translated label of the ring; left out, `label` is used.
 */
export function TabIndicator({ status, label, progress, progressLabel }: { status: TabStatus | null; label: string; progress?: number | null; progressLabel?: string }): JSX.Element | null {
  if (status === "working") {
    const percent = progressPercent(progress);
    if (percent !== null) {
      const text = progressLabel ?? label;
      return (
        <span className="ws-tab-ind" data-status="working" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={text} title={text}>
          {/* pathLength 100 makes the dash length the percent. */}
          <svg className="ws-tab-ring" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <circle className="ws-tab-ring-track" cx="6" cy="6" r="4.5" pathLength={100} />
            <circle className="ws-tab-ring-fill" cx="6" cy="6" r="4.5" pathLength={100} strokeDasharray={`${percent} 100`} />
          </svg>
        </span>
      );
    }
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
