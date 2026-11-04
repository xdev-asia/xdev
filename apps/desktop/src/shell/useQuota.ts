import { useEffect, useMemo, useState } from "react";
import type { Api, Quota } from "@/api";

const REFRESH_MS = 300_000;

export type QuotaState = { quota: Quota[] | null; loading: boolean; refresh(): void };

export type QuotaPoller = { start(): void; refresh(): void; stop(): void };

/**
 * Reads the quota now and every five minutes. `refresh` reads now and restarts the timer;
 * while a read is running it does nothing.
 */
export function createQuotaPoller(api: Api, onChange: (state: { quota: Quota[] | null; loading: boolean }) => void): QuotaPoller {
  let stopped = false;
  let loading = false;
  let quota: Quota[] | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const emit = () => !stopped && onChange({ quota, loading });
  const load = () => {
    if (loading) return;
    loading = true;
    emit();
    api.quota().then(
      (found) => { quota = found; },
      () => { quota = null; },
    ).finally(() => {
      loading = false;
      emit();
    });
  };
  const restart = () => {
    clearInterval(timer);
    timer = setInterval(load, REFRESH_MS);
  };
  return {
    start() { load(); restart(); },
    refresh() {
      if (stopped || loading) return;
      load();
      restart();
    },
    stop() { stopped = true; clearInterval(timer); },
  };
}

/** Quota for the status bar and the usage popover; `quota` is `null` until read, or when it cannot be read. */
export function useQuota(api: Api, paused: boolean): QuotaState {
  const [state, setState] = useState<{ quota: Quota[] | null; loading: boolean }>({ quota: null, loading: false });
  // The Accounts view polls on its own. Leaving it reads again, since the person may have signed in there.
  const poller = useMemo(() => (paused ? null : createQuotaPoller(api, setState)), [api, paused]);
  useEffect(() => {
    if (!poller) return;
    poller.start();
    return () => poller.stop();
  }, [poller]);
  return { quota: state.quota, loading: state.loading, refresh: () => poller?.refresh() };
}
