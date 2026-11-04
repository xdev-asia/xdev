import { useState } from "react";
import type { JSX } from "react";
import { Checkbox, Icon, Popover, Segmented } from "@xdev-asia/ui";
import type { SidebarGroupBy, SidebarPrefs, SidebarSort } from "@/api";
import { useI18n } from "@/i18n";
import { CARD_PARTS, type CardPart } from "./cardModel";

const GROUPS: readonly SidebarGroupBy[] = ["activity", "none", "status", "pr", "project"];
const SORTS: readonly SidebarSort[] = ["manual", "recent"];
const LAYOUTS = ["detailed", "compact"] as const;

/** The controls of the sidebar options: Group by, Sort by, card layout and the card properties. */
export function SidebarOptionsPanel(props: { prefs: SidebarPrefs; onPrefs(prefs: SidebarPrefs): void }): JSX.Element {
  const { t } = useI18n();
  const { prefs, onPrefs } = props;
  return (
    <div className="ws-options">
      <div className="ws-options-row">
        <span className="ws-options-label">{t("sidebar.options.groupBy")}</span>
        <Segmented
          label={t("sidebar.options.groupBy")}
          options={GROUPS.map((value) => ({ value, label: t(`sidebar.options.groupBy.${value}`) }))}
          value={prefs.groupBy}
          onChange={(value) => onPrefs({ ...prefs, groupBy: value as SidebarGroupBy })}
        />
      </div>
      <div className="ws-options-row">
        <span className="ws-options-label">{t("sidebar.options.sort")}</span>
        <Segmented
          label={t("sidebar.options.sort")}
          options={SORTS.map((value) => ({ value, label: t(`sidebar.options.sort.${value}`) }))}
          value={prefs.sort}
          onChange={(value) => onPrefs({ ...prefs, sort: value as SidebarSort })}
        />
      </div>
      <div className="ws-options-row">
        <span className="ws-options-label">{t("sidebar.options.layout")}</span>
        <Segmented
          label={t("sidebar.options.layout")}
          options={LAYOUTS.map((value) => ({ value, label: t(`sidebar.options.layout.${value}`) }))}
          value={prefs.compactCards ? "compact" : "detailed"}
          onChange={(value) => onPrefs({ ...prefs, compactCards: value === "compact" })}
        />
      </div>
      <div className="ws-options-props" role="group" aria-label={t("sidebar.options.props")}>
        <span className="ws-options-label">{t("sidebar.options.props")}</span>
        {CARD_PARTS.map((part: CardPart) => (
          <Checkbox
            key={part}
            label={t(`sidebar.options.props.${part}`)}
            checked={prefs.card[part]}
            onChange={(e) => onPrefs({ ...prefs, card: { ...prefs.card, [part]: e.target.checked } })}
          />
        ))}
      </div>
    </div>
  );
}

/** The options button of the sidebar header, with its popover. */
export function SidebarOptions(props: { prefs: SidebarPrefs; onPrefs(prefs: SidebarPrefs): void }): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      placement="bottom-end"
      label={t("sidebar.options.button")}
      trigger={(triggerProps) => (
        <button
          type="button"
          className="ws-icon-btn"
          aria-label={t("sidebar.options.button")}
          title={t("sidebar.options.button")}
          {...triggerProps}
          onClick={() => setOpen(!open)}
        >
          <Icon name="sliders" size={14} />
        </button>
      )}
    >
      <SidebarOptionsPanel prefs={props.prefs} onPrefs={props.onPrefs} />
    </Popover>
  );
}
