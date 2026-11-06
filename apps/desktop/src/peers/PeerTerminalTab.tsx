import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Banner, Button } from "@xdev-asia/ui";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { Terminal, type TerminalHandle } from "@/terminal/Terminal";
import { PeerTermClient } from "./peerTermClient";
import { atLeast } from "./peersModel";
import type { PeerTabEntry } from "./peerTabs";
import { usePeers } from "./usePeers";

/** How long the tab waits before it attaches again after the link dropped. */
export const REATTACH_MS = 2000;

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The chrome around the xterm: the read-only banner or the typing line, the disconnected banner and the control toggle. */
export function PeerTerminalView(props: {
  t: T;
  computer: string;
  tab: string;
  canControl: boolean;
  controlling: boolean;
  disconnected: boolean;
  onToggle(): void;
  children?: ReactNode;
}): JSX.Element {
  const { t, computer, tab } = props;
  const toggle = props.canControl && (
    <Button type="button" variant="secondary" onClick={props.onToggle}>
      {props.controlling ? t("peers.term.releaseControl") : t("peers.term.takeControl")}
    </Button>
  );
  return (
    <div className="peers-term">
      {props.disconnected && <Banner title={t("peers.term.disconnected", { computer })} />}
      {props.controlling ? (
        <Banner title={t("peers.term.controlling", { tab, computer })} action={toggle || undefined} />
      ) : (
        <Banner title={t("peers.term.readOnly")} action={toggle || undefined} />
      )}
      <div className="peers-term-body">{props.children}</div>
    </div>
  );
}

/** A terminal of another computer in a tab: its output read-only, and typing once the person takes control. */
export function PeerTerminalTab(props: { api: Api; entry: PeerTabEntry; onClosed?: () => void }): JSX.Element {
  const { api, entry } = props;
  const { t } = useI18n();
  const client = useMemo(() => new PeerTermClient(api, entry.peerId, entry.termId), [api, entry.peerId, entry.termId]);
  const [controlling, setControlling] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const handle = useRef<TerminalHandle>(null);
  const retryRef = useRef<() => void>(() => {});
  // The role as it is now: a change on the other computer shows in the open tab.
  const { peers } = usePeers(api);
  const canControl = atLeast(peers.find((p) => p.id === entry.peerId)?.theirRole ?? entry.theirRole, "operator");

  // A role taken away while typing ends the typing.
  const typing = controlling && canControl;
  client.controlling = typing;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stale = false;
    const retry = () => {
      if (stale) return;
      timer = setTimeout(() => {
        // A clean screen, then the new attach replays what the computer shows now.
        handle.current?.clear();
        client.attach().then(
          () => !stale && setDisconnected(false),
          retry,
        );
      }, REATTACH_MS);
    };
    retryRef.current = retry;
    const off = api.onPeerTermClosed((ev) => {
      if (ev.peerId !== entry.peerId || ev.termId !== entry.termId) return;
      if (ev.reason === "offline") {
        setDisconnected(true);
        setControlling(false);
        retry();
      } else props.onClosed?.();
    });
    return () => {
      stale = true;
      if (timer) clearTimeout(timer);
      void off.then((f) => f());
    };
    // The handlers read the entry's ids; a different tab is a different component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, client]);

  useEffect(() => () => void client.dispose(), [client]);

  const title = t("peers.term.tabTitle", { tab: entry.title, computer: entry.peerName });
  return (
    <PeerTerminalView t={t} computer={entry.peerName} tab={entry.title} canControl={canControl} controlling={typing} disconnected={disconnected} onToggle={() => setControlling((v) => !v)}>
      <Terminal
        api={api}
        id={entry.id}
        client={client.asPty()}
        cwd=""
        profile="shell"
        handleRef={handle}
        onStarted={() => {}}
        onError={() => {
          setDisconnected(true);
          retryRef.current();
        }}
      />
      <span className="peers-sr">{title}</span>
    </PeerTerminalView>
  );
}
