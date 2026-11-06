import type { JSX } from "react";
import { useI18n } from "@/i18n";

/** The `+` menu entries of a local project: run on its remote target, or set one. `alias` is null with no target. */
export function RemoteTargetMenu(props: { alias: string | null; onAgent(): void; onShell(): void; onSet(): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="ws-menu-group" role="group" aria-label={t("remote.sidebar.group")}>
      {props.alias !== null && (
        <>
          <button type="button" role="menuitem" onClick={props.onAgent}>
            {t("remote.plus.agent", { host: props.alias })}
          </button>
          <button type="button" role="menuitem" onClick={props.onShell}>
            {t("remote.plus.shell", { host: props.alias })}
          </button>
        </>
      )}
      <button type="button" role="menuitem" onClick={props.onSet}>
        {t("remote.target.set")}
      </button>
    </div>
  );
}
