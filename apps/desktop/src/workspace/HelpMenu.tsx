import { useState } from "react";
import type { JSX } from "react";
import { Icon, Menu, Popover } from "@xdev-asia/ui";
import type { MenuEntry } from "@xdev-asia/ui";
import type { Api, HelpLink } from "@/api";
import { useI18n } from "@/i18n";

export type HelpPick = "shortcuts" | HelpLink | "check-updates" | "reload" | "devtools" | "about" | "restart";

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
  { id: "check-updates", key: "checkUpdates" },
  { id: "reload", key: "reload" },
  { id: "devtools", key: "devtools" },
  { id: "separator" },
  { id: "about", key: "about" },
  { id: "restart", key: "restart" },
];

/** "Check for updates" from Help, the tray and the native menu: shows the page, and starts the check (one already running is joined). */
export function checkForUpdates(h: { openSettings(page: "general"): void; api: Pick<Api, "updateCheck"> }): void {
  h.openSettings("general");
  void h.api.updateCheck(false).catch(() => {});
}

/** What a Help menu pick does: the pages of the app it opens, and the shell calls it makes. */
export function runHelpPick(
  pick: HelpPick,
  h: { openSettings(page: "keys" | "general"): void; openUpdates(): void; openAbout(): void; api: Pick<Api, "shellQuit" | "helpOpen" | "windowReload" | "windowDevtoolsToggle"> },
): void {
  switch (pick) {
    case "shortcuts":
      return h.openSettings("keys");
    case "check-updates":
      return h.openUpdates();
    case "about":
      return h.openAbout();
    case "restart":
      return void h.api.shellQuit("restart").catch(() => {});
    case "reload":
      return void h.api.windowReload().catch(() => {});
    case "devtools":
      return void h.api.windowDevtoolsToggle().catch(() => {});
    default:
      return void h.api.helpOpen(pick).catch(() => {});
  }
}

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
