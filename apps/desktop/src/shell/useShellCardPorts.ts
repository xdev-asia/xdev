import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { SidebarPrefs, WorktreeView } from "@/api";
import type { useI18n } from "@/i18n";
import type { PortsStore } from "@/ports/portsStore";
import { livePortsByWorktree, stopFromCard, type LivePort } from "@/workspace/livePorts";
import { pushToast } from "@/workspace/toastStore";

type T = ReturnType<typeof useI18n>["t"];

/** The listening ports the worktree cards show, from the store the Ports panel reads. */
export function useShellCardPorts(o: { ports: PortsStore; prefs: SidebarPrefs; all: WorktreeView[]; t: T }) {
  const { ports, prefs, all, t } = o;
  // The cards' ports chip reads the same store as the Ports panel: one scanner, one poll.
  useSyncExternalStore(useCallback((fn: () => void) => ports.subscribe(fn), [ports]), ports.snapshot, ports.snapshot);
  const cardPorts = prefs.card.ports && !prefs.compactCards;
  useEffect(() => {
    ports.want("cards", cardPorts);
    return () => ports.want("cards", false);
  }, [ports, cardPorts]);
  // A hidden window polls the ports every 30 s instead of every 5 s.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => ports.setHidden(document.visibilityState === "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [ports]);
  const livePorts = cardPorts ? livePortsByWorktree(ports.state().scan) : {};
  async function stopPort(_wt: WorktreeView, port: LivePort): Promise<void> {
    await stopFromCard(ports, port, (key, vars) => pushToast({ text: t(key, vars) }));
  }
  const allPaths = JSON.stringify(all.map((w) => w.path));
  useEffect(() => {
    ports.setWorktrees(JSON.parse(allPaths) as string[]);
  }, [ports, allPaths]);
  useEffect(() => {
    const off = ports.watch();
    return () => {
      void off.then((fn) => fn());
      ports.dispose();
    };
  }, [ports]);

  return { livePorts, stopPort };
}
