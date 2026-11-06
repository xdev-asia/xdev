import { useCallback, useEffect, useState } from "react";
import type { Api, PeersState, PeerView } from "@/api";

/** The state of this computer's link and its paired computers, kept fresh by `peers://changed`. */
export function usePeers(api: Api): { state: PeersState | null; peers: PeerView[]; reload(): Promise<void> } {
  const [state, setState] = useState<PeersState | null>(null);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const reload = useCallback(async () => {
    const [s, l] = await Promise.all([api.peersState(), api.peersList()]);
    setState(s);
    setPeers(l);
  }, [api]);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      reload().catch(() => {});
    };
    load();
    const off = api.onPeersChanged(() => {
      if (live) load();
    });
    return () => {
      live = false;
      void off.then((f) => f());
    };
  }, [api, reload]);
  return { state, peers, reload };
}
