import type { Account, AccountRouting, Api, ApiError, Provider, Quota, QuotaAlert, RoutePolicy } from "./api";

/** What `pickAccount` needs of the provider's routing; like Rust `xdev_ai::Route`. */
export interface Route {
  policy: RoutePolicy;
  /** The provider's default (active) account. */
  default: string | null;
  priority: readonly string[];
  /** Percent used from which an account is passed over; null: only a full one is. */
  limit: number | null;
}

/** An account and the highest percent it has used; null when unknown. */
export interface Usage {
  id: string;
  used: number | null;
}

/**
 * The account a new agent starts on, like Rust `xdev_ai::pick_account`: an empty pool keeps the
 * default; Manual keeps it unless it is over `limit`; when every account is over, the least used
 * one. Unknown usage counts as the most used and is never over; ties go to the default, then pool order.
 */
export function pickAccount(route: Route, pool: readonly string[], quotas: readonly Usage[], lastUsed: string | null): string | null {
  if (pool.length === 0) return route.default;
  const limit = route.limit ?? 100;
  const used = (id: string) => quotas.find((u) => u.id === id)?.used ?? null;
  const over = (id: string) => {
    const u = used(id);
    return u !== null && u >= limit;
  };
  if (route.policy === "manual" && !(route.limit !== null && route.default !== null && over(route.default))) return route.default;
  const eligible = pool.filter((id) => !over(id));
  const leastUsed = (order: readonly string[]) => {
    let best: string | null = null;
    for (const id of order) {
      if (best === null) {
        best = id;
        continue;
      }
      const a = used(id) ?? Infinity;
      const b = used(best) ?? Infinity;
      if (a < b || (a === b && id === route.default && best !== route.default)) best = id;
    }
    return best;
  };
  if (eligible.length === 0) return leastUsed(pool);
  if (route.policy === "manual" || route.policy === "most_quota") return leastUsed(eligible);
  if (route.policy === "round_robin") {
    const at = lastUsed === null ? -1 : pool.indexOf(lastUsed);
    for (let i = 1; i <= pool.length; i++) {
      const id = pool[(at + i) % pool.length];
      if (!over(id)) return id;
    }
    return null;
  }
  const order = [...route.priority.filter((id) => pool.includes(id)), ...pool.filter((id) => !route.priority.includes(id))];
  return order.find((id) => !over(id)) ?? null;
}

const highest = (q: Quota | undefined): number | null => {
  const all = (q?.windows ?? []).flatMap((w) => (w.utilization === null || w.utilization === undefined ? [] : [w.utilization]));
  return all.length ? Math.max(...all) : null;
};

// api.ts imports the mocks, so its provider lists cannot be imported back without a cycle.
const ROUTED: readonly Provider[] = ["claude", "codex", "gemini"];
const WITH_QUOTA: readonly Provider[] = ["claude", "codex"];

export const defaultRouting = (provider: Provider): AccountRouting => ({ provider, policy: "manual", pool: [], priority: [], thresholds: [80, 95], autoSwitch: false, switchAt: 95 });

export type MockAccountRouting = Pick<Api, "accountsRouting" | "accountRoutingSet" | "accountUseNext" | "onQuotaAlert"> & {
  /** The account a new agent of `provider` starts on when it names none; the default when routing keeps it. */
  __route(provider: Provider): string | null;
  /** An agent of `provider` started on `name`: round robin goes on from it. */
  __started(provider: Provider, name: string): void;
  /** Raises a quota alert, as the quota poll would. */
  __quotaAlert(alert: QuotaAlert): void;
};

/** The demo's account routing, kept in memory like the registry's `routing` list. */
export function createMockAccountRouting(deps: {
  accounts: () => readonly Account[];
  quotas: () => readonly Quota[];
  active: (provider: Provider) => string | null;
  activate: (provider: Provider, name: string) => Promise<void>;
  changed: () => void;
}): MockAccountRouting {
  const routing = new Map<Provider, AccountRouting>();
  const lastUsed = new Map<Provider, string>();
  const alertListeners = new Set<(alert: QuotaAlert) => void>();
  // Like Rust `remove`: a removed account leaves the pool and the priority order.
  const get = (provider: Provider): AccountRouting => {
    const r = structuredClone(routing.get(provider) ?? defaultRouting(provider));
    const known = (name: string) => deps.accounts().some((a) => a.name === name);
    return { ...r, pool: r.pool.filter(known), priority: r.priority.filter(known) };
  };
  const reject = (code: ApiError["code"]): Promise<never> => Promise.reject({ code } satisfies ApiError);

  function route(provider: Provider, avoid: string | null): string | null {
    const r = get(provider);
    const signedOut = (name: string) => deps.quotas().some((q) => q.name === name && q.state === "unknown" && (q.reason === "logged_out" || q.reason === "expired" || q.reason === "no_credentials"));
    if (!ROUTED.includes(provider)) return null;
    const policy = avoid !== null && r.policy === "manual" ? (WITH_QUOTA.includes(provider) ? "most_quota" : "round_robin") : r.policy;
    // Like Rust `route`: "most quota" never picks an account with no quota source.
    const noSource = (name: string) => policy === "most_quota" && deps.quotas().some((q) => q.name === name && q.reason === "no_quota_source");
    const pool = deps
      .accounts()
      .filter((a) => a.provider === provider && (r.pool.length === 0 || r.pool.includes(a.name)) && !signedOut(a.name) && !noSource(a.name) && a.name !== avoid)
      .map((a) => a.name);
    if (r.pool.length > 0) pool.sort((a, b) => r.pool.indexOf(a) - r.pool.indexOf(b));
    const usage = deps.quotas().map((q) => ({ id: q.name, used: highest(q) }));
    const picked = pickAccount({ policy, default: deps.active(provider), priority: r.priority, limit: r.autoSwitch ? r.switchAt : null }, pool, usage, lastUsed.get(provider) ?? null);
    return avoid !== null && (pool.length === 0 || picked === avoid) ? null : picked;
  }

  return {
    async accountsRouting() {
      return ROUTED.map(get);
    },
    async accountRoutingSet(next) {
      const mine = new Set(deps.accounts().filter((a) => a.provider === next.provider).map((a) => a.name));
      const thresholds = [...new Set(next.thresholds)].sort((a, b) => a - b);
      const percent = (n: number) => Number.isInteger(n) && n >= 1 && n <= 100;
      const names = (list: string[]) => list.every((n) => mine.has(n)) && new Set(list).size === list.length;
      if (!ROUTED.includes(next.provider) || (next.policy === "most_quota" && !WITH_QUOTA.includes(next.provider))) return reject("bad_routing");
      if (!thresholds.every(percent) || thresholds.length > 4 || !percent(next.switchAt) || !names(next.pool) || !names(next.priority)) return reject("bad_routing");
      routing.set(next.provider, { ...structuredClone(next), thresholds });
      deps.changed();
    },
    async accountUseNext(provider, avoid) {
      const from = avoid ?? deps.active(provider);
      if (from === null) return null;
      const picked = route(provider, from);
      if (picked !== null) await deps.activate(provider, picked);
      return picked;
    },
    async onQuotaAlert(cb) {
      alertListeners.add(cb);
      return () => void alertListeners.delete(cb);
    },
    __route: (provider) => route(provider, null),
    __started(provider, name) {
      lastUsed.set(provider, name);
    },
    __quotaAlert(alert) {
      for (const cb of [...alertListeners]) cb(structuredClone(alert));
    },
  };
}
