import type { JSX } from "react";
import { AgentChip } from "@xdev-asia/ui";
import type { LineAttribution } from "@/api";
import { useI18n } from "@/i18n";
import { legendOf, OUTSIDE_CLASS } from "./lineGutterModel";

/** Who the gutter's markers stand for: one chip and name per agent tab, then "You". Nothing when no line is marked. */
export function LineLegend(props: { attr: LineAttribution | null }): JSX.Element | null {
  const { t } = useI18n();
  const entries = legendOf(props.attr, t);
  if (entries.length === 0) return null;
  return (
    <p className="attr-legend">
      <span>{t("review.attr.legend")}</span>
      {entries.map((e) => (
        <span className="attr-chip" key={e.key}>
          {e.spec.kind === "agent" ? <AgentChip profile={e.spec.profile} letter={e.spec.letter} title={e.name} /> : <span className={OUTSIDE_CLASS} role="img" aria-label={e.name} title={e.name} />}
          <span className="attr-chip-name">{e.name}</span>
        </span>
      ))}
    </p>
  );
}
