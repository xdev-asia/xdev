import type { JSX } from "react";
import { AgentChip } from "@xdev-asia/ui";
import type { Toucher } from "@/api";
import { useI18n } from "@/i18n";
import { chipNames, letterOf, profileOf } from "./attributionModel";

/** One chip per tab that touched a file, each with its agent's name; `compact` leaves the names out for a narrow list. */
export function AgentChips(props: { touchers: readonly Toucher[]; compact?: boolean }): JSX.Element | null {
  const { t } = useI18n();
  const { touchers, compact } = props;
  if (touchers.length === 0) return null;
  const unknown = t("review.attr.unknown");
  const names = chipNames(touchers, unknown);
  return (
    <span className="attr-chips" role="group" aria-label={t("review.attr.chips")}>
      {touchers.map((who, i) => (
        <span className="attr-chip" key={who.tabId ?? "unknown"} data-agent={who.agent ?? "unknown"}>
          <AgentChip profile={profileOf(who.agent)} letter={letterOf(who.agent)} title={names[i]} />
          {!compact && <span className="attr-chip-name">{names[i]}</span>}
        </span>
      ))}
    </span>
  );
}
