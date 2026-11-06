import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { StatusDot } from "@xdev-asia/ui";
import type { Api, SimDevice, SimList } from "@/api";
import { useI18n } from "@/i18n";
import { simGroups, simsEmpty } from "./simsModel";

/** The Simulators block for a loaded `list` (null while loading). */
export function SimsItems(props: {
  list: SimList | null;
  onPick(device: SimDevice): void;
  onRefresh(): void;
}): JSX.Element {
  const { t } = useI18n();
  const { list } = props;
  const groups = list ? simGroups(list, t) : [];
  return (
    <div role="group" aria-label={t("targets.sim")} data-testid="run-targets-sims">
      <div className="ws-menu-label" aria-hidden="true">
        {t("targets.sim")}
      </div>
      {!list && (
        <div className="targets-hint" role="status">
          {t("targets.sim.loading")}
        </div>
      )}
      {list && simsEmpty(list) && <div className="targets-hint">{t(list.ios === null && !list.problems.includes("targets.sim.noXcode") ? "targets.sim.noneAndroid" : "targets.sim.none")}</div>}
      {groups.map((g) => (
        <div key={g.key} role="group" aria-label={t(g.titleKey)}>
          <div className="ws-menu-label" aria-hidden="true">
            {t(g.titleKey)}
          </div>
          {g.rows.map((row) => (
            <button
              key={row.device.id}
              type="button"
              role="menuitem"
              className="targets-item"
              title={t(row.action === "boot" ? "targets.sim.boot" : "targets.sim.logs")}
              onClick={() => props.onPick(row.device)}
            >
              <StatusDot tone={row.running ? "ok" : "neutral"} />
              {row.label}
              <span className="targets-source">{t(row.action === "boot" ? "targets.sim.boot" : "targets.sim.logs")}</span>
            </button>
          ))}
        </div>
      ))}
      {list?.problems.map((key) => (
        <div key={key} className="targets-hint">
          {t(key)}
        </div>
      ))}
      <button type="button" role="menuitem" className="targets-item" onClick={props.onRefresh}>
        {t("targets.refresh")}
      </button>
    </div>
  );
}

/** Lists the simulators when it mounts (the menu opening) and again on Refresh. */
export function SimsGroup(props: { api: Pick<Api, "simsList">; onPick(device: SimDevice): void }): JSX.Element {
  const { api } = props;
  const [list, setList] = useState<SimList | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api.simsList().then(
      (l) => live && setList(l),
      () => live && setList({ ios: null, android: null, problems: [] }),
    );
    return () => {
      live = false;
    };
  }, [api, tick]);

  const refresh = useCallback(() => {
    setList(null);
    setTick((n) => n + 1);
  }, []);
  return <SimsItems list={list} onPick={props.onPick} onRefresh={refresh} />;
}
