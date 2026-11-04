import { useEffect } from "react";
import type { Api, ShellLabels } from "@/api";
import { useI18n } from "@/i18n";

/** The i18n key behind each label the native shell shows. */
export const SHELL_LABEL_KEYS: Record<keyof ShellLabels, string> = {
  trayTooltip: "shell.tray.tooltip",
  trayAttention: "shell.tray.attention",
  trayOpen: "shell.tray.open",
  about: "shell.help.about",
  settings: "shell.menu.settings",
  checkUpdates: "shell.menu.checkUpdates",
  hide: "shell.menu.hide",
  hideOthers: "shell.menu.hideOthers",
  showAll: "shell.menu.showAll",
  quitEndAll: "shell.menu.quitEndAll",
  quit: "shell.menu.quit",
  file: "shell.menu.file",
  edit: "shell.menu.edit",
  view: "shell.menu.view",
  window: "shell.menu.window",
  help: "shell.menu.help",
  reload: "shell.menu.reload",
  forceReload: "shell.menu.forceReload",
  devtools: "shell.menu.devtools",
  zoomReset: "shell.menu.zoomReset",
  zoomIn: "shell.menu.zoomIn",
  zoomOut: "shell.menu.zoomOut",
  leftSidebar: "shell.menu.leftSidebar",
  rightSidebar: "shell.menu.rightSidebar",
  fullscreen: "shell.menu.fullscreen",
  minimize: "shell.menu.minimize",
  zoom: "shell.menu.zoom",
  docs: "shell.help.docs",
  gettingStarted: "shell.help.gettingStarted",
  changelog: "shell.help.changelog",
  reportIssue: "shell.help.reportIssue",
};

export function shellLabels(t: (key: string) => string): ShellLabels {
  const out = {} as Record<string, string>;
  for (const [field, key] of Object.entries(SHELL_LABEL_KEYS)) out[field] = t(key);
  return out as unknown as ShellLabels;
}

/** Sends the tray and menu labels to the shell now and whenever the language changes. */
export function useShellLabels(api: Pick<Api, "shellLabelsSet">): void {
  const { t, locale } = useI18n();
  useEffect(() => {
    void api.shellLabelsSet(shellLabels(t)).catch(() => {});
    // `t` changes with the locale; the locale is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, locale]);
}
