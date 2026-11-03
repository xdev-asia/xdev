import type { JSX } from "react";

/** One row of a context menu. A `separator` row has only an id. */
export interface MenuItem {
  id: string;
  labelKey: string;
  /** Shown right aligned and muted, when the shortcut store gives one. */
  chord?: string;
  disabled?: boolean;
  danger?: boolean;
  run?: () => void;
  children?: MenuItem[];
  kind?: "separator";
}

/**
 * A menu at a point, in a portal, clamped to the window. Closes on outside click, Escape, blur and
 * scroll; arrows, Home / End, Enter, type-ahead, Left / Right for submenus.
 */
export function ContextMenu(p: { at: { x: number; y: number }; items: MenuItem[]; onClose(): void }): JSX.Element {
  // Contract stub: Lane U (U1).
  void p;
  return <div role="menu" />;
}
