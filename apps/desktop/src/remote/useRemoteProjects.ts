import { useCallback, useEffect, useState } from "react";
import type { Api, RemoteProjectView } from "@/api";
import { applyState } from "./model";

/** The remote projects with their live connection state: listed once, then `remote://state` events. */
export function useRemoteProjects(api: Partial<Pick<Api, "remoteProjectsList" | "onRemoteState">>): { projects: RemoteProjectView[]; reload(): Promise<void> } {
  const [projects, setProjects] = useState<RemoteProjectView[]>([]);

  const reload = useCallback(async () => {
    if (!api.remoteProjectsList) return;
    try {
      setProjects(await api.remoteProjectsList());
    } catch {
      // The list is an extra; a failure leaves the group as it was.
    }
  }, [api]);

  useEffect(() => {
    void reload();
    let off: (() => void) | undefined;
    let gone = false;
    void api.onRemoteState?.((view) => setProjects((cur) => applyState(cur, view.hostId, view.conn))).then((fn) => {
      if (gone) fn();
      else off = fn;
    });
    return () => {
      gone = true;
      off?.();
    };
  }, [api, reload]);

  return { projects, reload };
}
