import type { MenuItem } from "@/ui/ContextMenu";
import type { Row, Section } from "./model";
import { quickCommandMenuItems } from "./QuickCommandsMenu";

/**
 * The "Quick Commands" submenu of the terminal's right-click menu: the same rows as the popover
 * (without Recent), each running through `onChoose`. With no command it holds one disabled line.
 */
export function quickCommandsSubmenu(sections: Section[], onChoose: (row: Row) => void): MenuItem {
  const rows = quickCommandMenuItems(sections, onChoose);
  return {
    id: "quickCommands",
    labelKey: "termMenu.quickCommands",
    children: rows.length > 0 ? rows : [{ id: "quickCommandsNone", labelKey: "qcmd.empty", disabled: true }],
  };
}
