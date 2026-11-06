import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { Api, DeployPreset, TargetsView } from "@/api";
import { useI18n } from "@/i18n";
import { SimsGroup } from "./SimsGroup";
import { requestTargets } from "./targetsEvents";
import { deployEntries, isEmpty, needsTrust, serverEntry } from "./targetsModel";

/**
 * The "Run targets" block of the `+` menu: deploy presets, the server shell, and a way to review
 * `xdev.toml` first. `simulators` and `devices` are slots for the mobile lane; empty for now.
 */
export function RunTargetsMenu(props: {
  api: Pick<Api, "targetsList" | "simsList">;
  worktree: string;
  onDeploy(preset: DeployPreset): void;
  onServer(view: TargetsView): void;
  onReview(view: TargetsView): void;
  simulators?: ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  const { api, worktree } = props;
  const [view, setView] = useState<TargetsView | null>(null);

  useEffect(() => {
    let live = true;
    api.targetsList(worktree).then(
      (v) => live && setView(v),
      () => live && setView(null),
    );
    return () => {
      live = false;
    };
  }, [api, worktree]);

  // The simulators block starts a device through the tab strip's owner (`useRunTargets`).
  const simulators = props.simulators ?? <SimsGroup api={api} onPick={(device) => requestTargets({ kind: "sim", device })} />;
  return <RunTargetsItems view={view} {...props} simulators={simulators} />;
}

/** The menu block for a loaded `view` (null while loading). */
export function RunTargetsItems(props: {
  view: TargetsView | null;
  onDeploy(preset: DeployPreset): void;
  onServer(view: TargetsView): void;
  onReview(view: TargetsView): void;
  simulators?: ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  const { view } = props;
  const deploy = view ? deployEntries(view) : [];
  const server = view ? serverEntry(view) : null;
  return (
    <div className="ws-menu-group" role="group" aria-label={t("targets.menu.title")} data-testid="run-targets">
      <div className="ws-menu-label" aria-hidden="true">
        {t("targets.menu.title")}
      </div>
      {view && isEmpty(view) && <div className="targets-hint">{t("targets.deploy.none")}</div>}
      {deploy.length > 0 && (
        <div role="group" aria-label={t("targets.deploy.group")}>
          <div className="ws-menu-label" aria-hidden="true">
            {t("targets.deploy.group")}
          </div>
          {deploy.map((e) => (
            <button
              key={e.preset.name}
              type="button"
              role="menuitem"
              className="targets-item"
              disabled={e.disabled !== null}
              title={e.disabled ? t("targets.untrusted.hint") : e.preset.run}
              onClick={() => props.onDeploy(e.preset)}
            >
              {e.preset.name}
              <span className="targets-source">{t(e.preset.source === "repo" ? "targets.source.repo" : "targets.source.detected")}</span>
            </button>
          ))}
        </div>
      )}
      {server && (
        <div role="group" aria-label={t("targets.server.group")}>
          <div className="ws-menu-label" aria-hidden="true">
            {t("targets.server.group")}
          </div>
          <button
            type="button"
            role="menuitem"
            className="targets-item"
            disabled={server.disabled !== null}
            title={server.disabled ? t("targets.untrusted.hint") : server.vps.host}
            onClick={() => view && props.onServer(view)}
          >
            {t("targets.server.open")}
            <span className="targets-source">{server.vps.host}</span>
          </button>
          {!server.hostKnown && <div className="targets-hint">{t("targets.vps.noHost", { host: server.vps.host })}</div>}
        </div>
      )}
      {view && needsTrust(view) && (
        <>
          <div className="targets-hint" role="status">
            {t("targets.untrusted.hint")}
          </div>
          <button type="button" role="menuitem" className="targets-item" onClick={() => props.onReview(view)}>
            {t("targets.untrusted.review")}
          </button>
        </>
      )}
      {props.simulators}
    </div>
  );
}
