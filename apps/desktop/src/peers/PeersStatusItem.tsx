import { useState } from "react";
import type { JSX } from "react";
import { Badge, Popover } from "@xdev-asia/ui";
import type { Api, PeerView } from "@/api";
import { useI18n } from "@/i18n";
import { ComputersPanel } from "./ComputersPanel";
import { usePeers } from "./usePeers";

/** The footer segment: "Computers" and how many are online; hidden while no computer is paired. */
export function PeersStatusView(props: { peers: readonly PeerView[]; api: Api; open: boolean; onToggle(): void; onClose(): void }): JSX.Element | null {
  const { t } = useI18n();
  if (props.peers.length === 0) return null;
  const online = props.peers.filter((p) => p.online).length;
  const label = t("peers.footer.label", { count: online });
  return (
    <Popover
      open={props.open}
      onClose={props.onClose}
      placement="top-start"
      className="peers-panel"
      label={t("peers.panel.title")}
      trigger={(aria) => (
        <button type="button" className="ws-footer-link ws-peers" data-action="peers" title={label} aria-label={label} {...aria} onClick={props.onToggle}>
          {t("peers.footer")}
          <Badge>{online}</Badge>
        </button>
      )}
    >
      <ComputersPanel api={props.api} peers={props.peers} onClose={props.onClose} />
    </Popover>
  );
}

/** The live segment: follows `peers://changed`. */
export function PeersStatusItem(props: { api: Api }): JSX.Element | null {
  const { peers } = usePeers(props.api);
  const [open, setOpen] = useState(false);
  return <PeersStatusView api={props.api} peers={peers} open={open} onToggle={() => setOpen((v) => !v)} onClose={() => setOpen(false)} />;
}
