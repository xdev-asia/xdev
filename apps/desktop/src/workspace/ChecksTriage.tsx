import type { JSX } from "react";
import type { Check } from "@/api";
import { useI18n } from "@/i18n";
import { failingChecks, triage } from "./checksPolicy";

const DOT = { failing: "fail", cancelled: "cancel", pending: "pending", unresolved: "skipping" } as const;

/**
 * One line above the checks that says what needs attention first: failures, cancelled runs,
 * unfinished runs, or checks that were all skipped. "Fix" gives every failing check to an agent once.
 */
export function ChecksTriage(props: {
  checks: readonly Check[];
  /** Left out, or while the agent actions are off, the strip has no Fix. */
  onFix?: (checks: Check[]) => void;
  fixing?: boolean;
}): JSX.Element | null {
  const { t } = useI18n();
  const { kind, count } = triage(props.checks);
  if (kind === "none") return null;
  const text = t(count === 1 ? `checks.triage.${kind}.one` : `checks.triage.${kind}`, { count });
  return (
    <div className="ws-checks-triage" data-triage={kind} role="status">
      <span className="ws-dot" data-check={DOT[kind]} aria-hidden="true" />
      <span>{text}</span>
      {kind === "failing" && props.onFix && (
        <button type="button" className="ws-checks-btn" data-fix-all disabled={props.fixing} onClick={() => props.onFix?.(failingChecks(props.checks))}>
          {t("checks.fix")}
        </button>
      )}
    </div>
  );
}
