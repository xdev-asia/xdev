import type { MenuAction } from "@/api";
import { ZOOM_STEP } from "@/ui/zoom";

export interface MenuHandlers {
  openSettings(): void;
  openShortcuts(): void;
  openUpdates(): void;
  confirmQuitEndAll(): void;
  /** A zoom step; 0 resets. */
  zoom(delta: number): void;
  toggleLeftSidebar(): void;
  toggleRightSidebar(): void;
  openAbout(): void;
}

/** What a native menu or tray item does inside the webview. */
export function runMenuAction(action: MenuAction, h: MenuHandlers): void {
  switch (action) {
    case "open-settings":
      return h.openSettings();
    case "shortcuts":
      return h.openShortcuts();
    case "check-updates":
      return h.openUpdates();
    case "quit-end-all":
      return h.confirmQuitEndAll();
    case "zoom-in":
      return h.zoom(ZOOM_STEP);
    case "zoom-out":
      return h.zoom(-ZOOM_STEP);
    case "zoom-reset":
      return h.zoom(0);
    case "toggle-left-sidebar":
      return h.toggleLeftSidebar();
    case "toggle-right-sidebar":
      return h.toggleRightSidebar();
    case "about":
      return h.openAbout();
  }
}
