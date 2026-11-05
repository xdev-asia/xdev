import { useSyncExternalStore } from "react";
import type { Accounts, Api, Quota } from "@/api";
import { createQuotaPoller, type QuotaPoller } from "@/shell/useQuota";

export interface QuotaSnapshot {
  quota: Quota[] | null;
  accounts: Accounts | null;
}

const EMPTY: QuotaSnapshot = { quota: null, accounts: null };

/**
 * One reader of the quota for every header chip, built on the footer's poller (read now, then every five
 * minutes). It runs while a chip is on screen. The accounts are read with each quota to know the active one.
 */
export function createQuotaStore(api: Pick<Api, "quota" | "accounts">) {
  let snap = EMPTY;
  let poller: QuotaPoller | null = null;
  let users = 0;
  const listeners = new Set<() => void>();
  const set = (next: Partial<QuotaSnapshot>) => {
    snap = { ...snap, ...next };
    for (const cb of listeners) cb();
  };
  return {
    snapshot: () => snap,
    subscribe(cb: () => void) {
      listeners.add(cb);
      if (users++ === 0) {
        poller = createQuotaPoller(api as Api, ({ quota, loading }) => {
          if (loading) return;
          set({ quota });
          void api.accounts().then((accounts) => set({ accounts }), () => {});
        });
        poller.start();
      }
      return () => {
        listeners.delete(cb);
        if (--users === 0) {
          poller?.stop();
          poller = null;
        }
      };
    },
  };
}

const NOOP_SUBSCRIBE = (_cb: () => void) => () => {};
const stores = new WeakMap<object, ReturnType<typeof createQuotaStore>>();

/** The quota and accounts for the chips of `api`; null fields until read or when they cannot be. */
export function useChipQuota(api: Pick<Api, "quota" | "accounts">, on: boolean): QuotaSnapshot {
  let store = stores.get(api);
  if (!store) {
    store = createQuotaStore(api);
    stores.set(api, store);
  }
  const s = store;
  return useSyncExternalStore(
    on ? s.subscribe : NOOP_SUBSCRIBE,
    s.snapshot,
    s.snapshot,
  );
}
