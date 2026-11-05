import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { Disclosure, EmptyState, IconButton, ListRow } from "@xdev-asia/ui";
import { toApiError, type Api, type ApiError, type WorkspacePort } from "@/api";
import { useI18n } from "@/i18n";
import { copyText } from "@/ui/clipboard";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import { groupPorts, portAddress, portOwner } from "./portSections";
import type { PortsStore } from "./portsStore";

/** The listening ports of the workspaces, in the right panel. */
export function PortsPanel(props: {
  api: Api;
  store: PortsStore;
  /** The worktree in front; null when none is selected. */
  active: string | null;
  /** True while the tab is in front; the store polls only then. */
  visible: boolean;
}): JSX.Element {
  const { api, store, active, visible } = props;
  const { t } = useI18n();
  const [note, setNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; port: WorkspacePort } | null>(null);
  // Stop asks first, like the card chip; a port no xDev terminal started asks a second time.
  const [asking, setAsking] = useState<{ id: string; outside: boolean } | null>(null);

  useSyncExternalStore(useCallback((fn: () => void) => store.subscribe(fn), [store]), () => store.snapshot(), () => store.snapshot());
  const { scan, error, loading } = store.state();

  useEffect(() => {
    store.setVisible(visible);
    return () => store.setVisible(false);
  }, [store, visible]);

  const fail = (e: unknown) => {
    setNote(null);
    setActionError(toApiError(e));
  };
  const open = (p: WorkspacePort) => {
    setActionError(null);
    api.portsOpen(p.id).catch(fail);
  };
  const copy = async (text: string) => {
    setActionError(null);
    if (await copyText(text)) setNote(t("ports.copied", { address: text }));
  };
  const askStop = (p: WorkspacePort) => {
    setActionError(null);
    setNote(null);
    setAsking({ id: p.id, outside: false });
  };
  const stop = async (p: WorkspacePort, outsideTerminal: boolean) => {
    setActionError(null);
    setAsking(null);
    setNote(null);
    try {
      await store.stop(p.id, { confirmed: true, outsideTerminal });
      setNote(t("ports.stopped", { port: p.port }));
    } catch (e) {
      // The listener is the terminal's own process: stopping it ends the terminal, so ask once more.
      if (!outsideTerminal && toApiError(e).code === "port_terminal_root") {
        setAsking({ id: p.id, outside: true });
        setNote(t("ports.stopTerminalNote", { port: p.port }));
        return;
      }
      fail(e);
    }
  };
  /** The confirming click: stops a port under an xDev terminal, else asks once more. */
  const confirmStop = (p: WorkspacePort) => {
    if (asking?.outside || p.evidence === "terminal") {
      void stop(p, asking?.outside ?? false);
      return;
    }
    setAsking({ id: p.id, outside: true });
    setNote(t("ports.stopOutsideNote", { port: p.port }));
  };
  const cancelStop = () => {
    setAsking(null);
    setNote(null);
  };
  const canStop = (p: WorkspacePort) => p.kind === "workspace" && p.pid !== null;

  const items = (p: WorkspacePort): MenuItem[] => [
    { id: "open", labelKey: "ports.open", run: () => open(p) },
    { id: "copy", labelKey: "ports.copy", run: () => void copy(portAddress(p)) },
    { id: "details", labelKey: "ports.copyDetails", run: () => void copy(JSON.stringify(p, null, 2)) },
    { id: "sep", labelKey: "", kind: "separator" },
    { id: "stop", labelKey: "ports.stop", danger: true, disabled: !canStop(p), run: () => askStop(p) },
  ];

  const row = (p: WorkspacePort) => {
    const owner = portOwner(p);
    const who = owner.kind === "worktree" ? owner.name : owner.kind === "container" ? t("ports.owner.container") : t("ports.owner.unassigned");
    const how = p.evidence ? ` · ${t(`ports.evidence.${p.evidence}`)}` : "";
    const process = p.processName ?? (p.pid !== null ? t("ports.process.pid", { pid: p.pid }) : t("ports.process.unknown"));
    const address = portAddress(p);
    const ask = asking?.id === p.id ? asking : null;
    return (
      <ListRow
        key={p.id}
        as="li"
        className="pt-row"
        title={
          <span className="pt-line">
            <span className="pt-port">{`:${p.port}`}</span>
            <span className="pt-process">{process}</span>
          </span>
        }
        meta={
          <span className="pt-meta" onContextMenu={(e) => { e.preventDefault(); setMenu({ at: { x: e.clientX, y: e.clientY }, port: p }); }}>
            <span className="pt-address" title={address}>{address}</span>
            <span className="pt-owner" title={`${who}${how}`}>{`${who}${how}`}</span>
          </span>
        }
        trailing={
          <span className="pt-actions">
            <IconButton icon="globe" label={t("ports.open")} onClick={() => open(p)} />
            <IconButton icon="copy" label={t("ports.copy")} onClick={() => void copy(address)} />
            {canStop(p) && !ask && <IconButton icon="stop" label={t("ports.stop")} onClick={() => askStop(p)} />}
            {canStop(p) && ask && (
              <>
                <button type="button" className="btn-secondary pt-stop" data-action={ask.outside ? "stop-outside" : "stop-confirm"} onClick={() => confirmStop(p)}>
                  {ask.outside ? t("ports.stopOutside") : t("ports.stopConfirm", { port: p.port })}
                </button>
                <IconButton icon="close" label={t("dialog.cancel")} onClick={cancelStop} />
              </>
            )}
          </span>
        }
      />
    );
  };

  const section = (id: string, title: string, list: WorkspacePort[], collapsed: boolean) => (
    <Disclosure key={id} className="pt-section" title={title} count={list.length} defaultExpanded={!collapsed}>
      <ul className="pt-list">{list.map(row)}</ul>
    </Disclosure>
  );

  const groups = scan ? groupPorts(scan.ports, active) : null;
  // No terminal runs in these worktrees, so the OS was not read: an empty state, not a failure.
  const idle = scan?.unavailable === "no_terminal";
  const message = scan?.unavailable && !idle
    ? scan.unavailable === "scan_timeout"
      ? t("ports.paused", { seconds: scan.retryIn ?? 0 })
      : t("ports.unavailable", { platform: scan.platform, reason: scan.detail ?? scan.unavailable })
    : null;

  let body: JSX.Element | null = null;
  if (active === null) body = <EmptyState title={t("ports.empty.noWorkspace")} />;
  else if (!scan) body = error ? null : <EmptyState title={t("ports.empty.scanning")} />;
  else if (idle) body = <EmptyState title={t("ports.empty.noTerminal")} />;
  else if (groups && scan.ports.length === 0) body = message ? null : <EmptyState title={t("ports.empty.none")} />;
  else if (groups) {
    body = (
      <>
        {groups.active.length === 0 && <EmptyState title={t("ports.empty.noLocal")} />}
        {groups.active.length > 0 && section("active", t("ports.section.active"), groups.active, false)}
        {groups.other.length > 0 && section("other", t("ports.section.other"), groups.other, true)}
        {groups.external.length > 0 && section("external", t("ports.section.external"), groups.external, true)}
      </>
    );
  }

  const failure = actionError ?? error;
  return (
    <div className="pt-panel">
      <div className="pt-toolbar">
        <IconButton icon="refresh" label={t("ports.refresh")} disabled={loading} onClick={() => void store.refresh()} />
      </div>
      {failure && (
        <p className="error-text" role="alert">
          {t(`error.${failure.code}`)}
        </p>
      )}
      {message && (
        <p className="pt-note" role="status">
          {message}
        </p>
      )}
      {note && (
        <p className="pt-note" role="status">
          {note}
        </p>
      )}
      {body}
      {menu && <ContextMenu at={menu.at} items={items(menu.port)} onClose={() => setMenu(null)} />}
    </div>
  );
}
