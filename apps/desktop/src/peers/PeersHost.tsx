import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api, PeerConfirm as PeerConfirmEvent, PeerPairRequest, PeerRole } from "@/api";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { PairRequestDialog } from "./PairRequestDialog";
import { PeerConfirm } from "./PeerConfirm";
import { activityText } from "./peersModel";

/** The host side of pairing, mounted once for the window: pair requests, confirms and activity toasts. */
export function PeersHost(props: { api: Api }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [requests, setRequests] = useState<PeerPairRequest[]>([]);
  const [confirms, setConfirms] = useState<PeerConfirmEvent[]>([]);

  useEffect(() => {
    const offs = [
      api.onPeerPairRequest((r) => setRequests((q) => [...q, r])),
      api.onPeerConfirm((c) => setConfirms((q) => [...q, c])),
      api.onPeerActivity((ev) => pushToast({ text: activityText(t, ev) })),
    ];
    return () => {
      for (const off of offs) void off.then((f) => f());
    };
    // The toast text is made when the event arrives, with the language of that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const request = requests[0];
  const confirm = confirms[0];
  return (
    <>
      {request && (
        <PairRequestDialog
          key={request.requestId}
          request={request}
          onAnswer={(accept: boolean, role: PeerRole) => {
            setRequests((q) => q.filter((r) => r.requestId !== request.requestId));
            void api.peerPairConfirm(request.requestId, accept, role).catch(() => {});
          }}
        />
      )}
      {confirm && (
        <PeerConfirm
          key={confirm.requestId}
          request={confirm}
          onReply={(allow) => {
            setConfirms((q) => q.filter((c) => c.requestId !== confirm.requestId));
            void api.peerConfirmReply(confirm.requestId, allow).catch(() => {});
          }}
        />
      )}
    </>
  );
}
