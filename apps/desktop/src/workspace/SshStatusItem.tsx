import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Menu, Popover, StatusDot, type MenuEntry } from "@xdev-asia/ui";
import { toApiError, type Api, type SshConnState, type SshConnectionView, type SshHost } from "@/api";
import { useI18n } from "@/i18n";
import { connLine, isLive } from "@/settings/ssh/sshModel";
import { pushToast } from "./toastStore";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** How many kept connections are up and on their way; null hides the segment. */
export function sshSegment(conns: readonly SshConnectionView[]): { connected: number; connecting: number } | null {
  const connected = conns.filter((c) => c.state.kind === "connected").length;
  const connecting = conns.filter((c) => c.state.kind === "connecting").length;
  return connected + connecting === 0 ? null : { connected, connecting };
}

export interface SshMenuActions {
  connect(hostId: string): void;
  disconnect(hostId: string): void;
  /** Opens an SSH terminal tab; the item shows only when this is given. */
  openTerminal?: (alias: string) => void;
  manage(): void;
}

/** The menu: per host its state, Connect or Disconnect, and Open terminal; Manage hosts last. */
export function sshMenuEntries(hosts: readonly Pick<SshHost, "id" | "alias">[], conns: ReadonlyMap<string, SshConnState>, t: T, act: SshMenuActions): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const h of hosts) {
    const state = conns.get(h.id) ?? { kind: "disconnected" as const };
    const line = connLine(state);
    entries.push({ type: "group", label: `${h.alias} · ${t(line.key, line.vars)}` });
    entries.push(
      isLive(state)
        ? { label: t("ssh.footer.disconnect", { alias: h.alias }), onSelect: () => act.disconnect(h.id) }
        : { label: t("ssh.footer.connect", { alias: h.alias }), onSelect: () => act.connect(h.id) },
    );
    const openTerminal = act.openTerminal;
    if (openTerminal) entries.push({ label: t("ssh.footer.openTerminal", { alias: h.alias }), onSelect: () => openTerminal(h.alias) });
  }
  if (entries.length > 0) entries.push({ type: "separator" });
  entries.push({ label: t("ssh.footer.manage"), onSelect: act.manage });
  return entries;
}

/** The footer segment: a dot and the count of live connections, opening the host menu. */
export function SshStatusView(props: {
  segment: { connected: number; connecting: number };
  entries: MenuEntry[];
  open: boolean;
  onToggle(): void;
  onClose(): void;
}): JSX.Element {
  const { t } = useI18n();
  const { connected, connecting } = props.segment;
  const label = t("ssh.footer.label", { connected, connecting });
  return (
    <Popover
      open={props.open}
      onClose={props.onClose}
      placement="top-start"
      className="ws-ssh-menu"
      label={t("ssh.footer.menu")}
      trigger={(aria) => (
        <button type="button" className="ws-footer-link ws-ssh" data-action="ssh" title={label} aria-label={label} {...aria} onClick={props.onToggle}>
          <StatusDot tone={connected > 0 ? "ok" : "warn"} />
          {t("ssh.footer.item", { count: connected + connecting })}
        </button>
      )}
    >
      <Menu label={t("ssh.footer.menu")} items={props.entries} />
    </Popover>
  );
}

type SshItemApi = Pick<Api, "sshConnectionsList" | "onSshState" | "sshHostsList" | "sshConnect" | "sshDisconnect">;

/** The live segment: follows `ssh://state`, hidden while no host is connected or connecting. */
export function SshStatusItem(props: { api: SshItemApi; onOpenTerminal?: (alias: string) => void; onManage(): void }): JSX.Element | null {
  const { api } = props;
  const { t } = useI18n();
  const [conns, setConns] = useState<ReadonlyMap<string, SshConnectionView>>(new Map());
  const [hosts, setHosts] = useState<SshHost[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let stale = false;
    const put = (v: SshConnectionView) => !stale && setConns((m) => new Map(m).set(v.hostId, v));
    const unlisten = api.onSshState(put);
    api.sshConnectionsList().then(
      (list) => !stale && setConns((m) => new Map([...list.map((v) => [v.hostId, v] as const), ...m])),
      () => {},
    );
    return () => {
      stale = true;
      void unlisten.then((off) => off(), () => {});
    };
  }, [api]);
  // The saved hosts are read each time the menu opens, so one added in Settings shows.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    api.sshHostsList().then((found) => !stale && setHosts(found), () => !stale && setHosts(null));
    return () => {
      stale = true;
    };
  }, [api, open]);

  const segment = sshSegment([...conns.values()]);
  if (!segment) return null;
  const close = () => setOpen(false);
  const failed = (e: unknown) => pushToast({ text: t(`error.${toApiError(e).code}`) });
  const listed = hosts ?? [...conns.values()].map((v) => ({ id: v.hostId, alias: v.alias }));
  const entries = sshMenuEntries(
    listed,
    new Map([...conns].map(([id, v]) => [id, v.state])),
    t,
    {
      connect: (id) => {
        close();
        api.sshConnect(id).then((v) => setConns((m) => new Map(m).set(id, v)), failed);
      },
      disconnect: (id) => {
        close();
        api.sshDisconnect(id).catch(failed);
      },
      openTerminal:
        props.onOpenTerminal &&
        ((alias) => {
          close();
          props.onOpenTerminal?.(alias);
        }),
      manage: () => {
        close();
        props.onManage();
      },
    },
  );
  return <SshStatusView segment={segment} entries={entries} open={open} onToggle={() => setOpen((v) => !v)} onClose={close} />;
}
