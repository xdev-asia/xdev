import { useCallback, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { portCounts } from "./portSections";
import type { PortsStore } from "./portsStore";

/** The button: no hooks, so it draws on the server for tests. */
export function PortsItemView(props: { counts: { workspace: number; external: number } | null; onOpen(): void }): JSX.Element {
  const { t } = useI18n();
  const { counts } = props;
  const title = counts && counts.external > 0 ? t("ports.status.titleExternal", { external: counts.external }) : t("ports.status.title");
  return (
    <button type="button" className="ws-footer-link ws-ports" data-action="show-ports" title={title} onClick={props.onOpen}>
      {counts ? t("ports.status.label", { count: counts.workspace }) : t("ports.tab")}
    </button>
  );
}

/** The footer item: how many ports the worktree in front has. A click shows the Ports tab. */
export function PortsItem(props: { store: PortsStore; active: string | null; onOpen(): void }): JSX.Element {
  const { store, active, onOpen } = props;
  useSyncExternalStore(useCallback((fn: () => void) => store.subscribe(fn), [store]), () => store.snapshot(), () => store.snapshot());
  const scan = store.state().scan;
  return <PortsItemView counts={scan ? portCounts(scan.ports, active) : null} onOpen={onOpen} />;
}
