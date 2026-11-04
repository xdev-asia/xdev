import { useState } from "react";
import type { JSX } from "react";
import { Icon, Menu, Popover } from "@xdev-asia/ui";
import type { MenuEntry } from "@xdev-asia/ui";
import type { HelpLink } from "@/api";
import { useI18n } from "@/i18n";

export type HelpPick = "shortcuts" | HelpLink | "about" | "restart";

type HelpItem = { id: HelpPick; key: string } | { id: "separator" };

/** The Help menu, top to bottom. */
export const HELP_ITEMS: HelpItem[] = [
  { id: "shortcuts", key: "shortcuts" },
  { id: "separator" },
  { id: "docs", key: "docs" },
  { id: "getting-started", key: "gettingStarted" },
  { id: "changelog", key: "changelog" },
  { id: "report-issue", key: "reportIssue" },
  { id: "source", key: "source" },
  { id: "separator" },
  { id: "about", key: "about" },
  { id: "restart", key: "restart" },
];

export function HelpMenu(props: { onPick(pick: HelpPick): void }): JSX.Element {
  const { t } = useI18n();
  const items: MenuEntry[] = HELP_ITEMS.map((i) =>
    "key" in i ? { label: t(`shell.help.${i.key}`), onSelect: () => props.onPick(i.id) } : { type: "separator" },
  );
  return <Menu items={items} label={t("shell.help.label")} />;
}

/** The header's help button, with its menu. */
export function HelpButton(props: { onPick(pick: HelpPick): void }): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      placement="bottom-end"
      label={t("shell.help.label")}
      trigger={(triggerProps) => (
        <button
          type="button"
          className="ws-icon-btn ws-header-btn"
          aria-label={t("shell.help.label")}
          title={t("shell.help.label")}
          {...triggerProps}
          onClick={() => setOpen(!open)}
        >
          <Icon name="help" size={16} />
        </button>
      )}
    >
      <HelpMenu
        onPick={(pick) => {
          setOpen(false);
          props.onPick(pick);
        }}
      />
    </Popover>
  );
}
