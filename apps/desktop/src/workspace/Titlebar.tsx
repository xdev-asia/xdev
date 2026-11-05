import { useEffect, useState } from "react";
import type { JSX } from "react";
import { IconButton } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { PLATFORM, type Platform } from "@/platform";
import { useTitlebar } from "@/ui/titlebar";
import { windowControls as defaultControls, type WindowControls } from "./windowControls";

export interface TitlebarProps {
  platform?: Platform;
  controls?: WindowControls;
}

/**
 * The window's own title bar, drawn only when Settings → Appearance → Title bar is Custom. The
 * drag region moves the window and a double-click on it toggles maximize. macOS keeps its traffic
 * lights, so only an inset is left for them; Windows and Linux get minimize, maximize and close.
 */
export function Titlebar({ platform = PLATFORM, controls = defaultControls }: TitlebarProps): JSX.Element | null {
  const { t } = useI18n();
  const { mode, showName } = useTitlebar();
  const [maximized, setMaximized] = useState(false);
  const mac = platform === "mac";
  const custom = mode === "custom";

  useEffect(() => {
    if (!custom || mac) return;
    let off: (() => void) | undefined;
    let gone = false;
    const sync = () => void controls.isMaximized().then((m) => !gone && setMaximized(m), () => {});
    sync();
    controls.onResized(sync).then(
      (un) => (gone ? un() : (off = un)),
      () => {},
    );
    return () => {
      gone = true;
      off?.();
    };
  }, [custom, mac, controls]);

  if (!custom) return null;
  return (
    <div className="ws-titlebar" data-platform={platform} data-tauri-drag-region="deep">
      {showName && <span className="ws-titlebar-name">{t("titlebar.appName")}</span>}
      {!mac && (
        <div className="ws-titlebar-controls">
          <IconButton icon="minus" label={t("titlebar.minimize")} onClick={() => void controls.minimize()} />
          <IconButton
            icon={maximized ? "minimize" : "maximize"}
            label={t(maximized ? "titlebar.restore" : "titlebar.maximize")}
            onClick={() => void controls.toggleMaximize()}
          />
          <IconButton icon="close" label={t("titlebar.close")} className="ws-titlebar-close" onClick={() => void controls.close()} />
        </div>
      )}
    </div>
  );
}
