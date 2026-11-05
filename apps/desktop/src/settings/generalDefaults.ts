import type { DiffSettings, NavigationSettings } from "@/api";

/** `NavigationSettings::default()` in Rust. */
export const NAVIGATION_DEFAULTS: NavigationSettings = {
  tabOrder: "mru",
  confirmClosePinned: true,
  confirmCloseRunning: true,
  askBeforeDeleteWorktree: true,
  alwaysForceDeleteWorktrees: false,
  alwaysDeleteKeptBranches: false,
};

/** `DiffSettings::default()` in Rust. */
export const DIFF_DEFAULTS: DiffSettings = {
  defaultView: "inline",
  ignoreWhitespace: false,
  collapseUnchanged: true,
  wordWrap: false,
  fileTree: false,
};
