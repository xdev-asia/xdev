import { useCallback, useEffect, useState } from "react";
import type { LicenseState } from "@xdev/bindings";
import { api as defaultApi, type Api } from "@/api";

export type LicenseApi = Pick<Api, "licenseState" | "licenseRefresh" | "onLicenseChanged">;

/** A notice key the license page and the status surfaces translate (`license.notice.*`). */
export type LicenseNotice = "grace" | "expired" | "clock" | "revoked" | "noSeat" | "checkoutTimeout" | "unavailable";

export interface License {
  /** Null until the first read answers. */
  state: LicenseState | null;
  /** The plans this device has; empty when free. */
  plan: string[];
  /** Whether this device may use a Pro feature. False until the state is known. */
  allows(feature: string): boolean;
  /** What the person should be told about the license, if anything. */
  notice: LicenseNotice | null;
  /** Asks the service for a fresh token; the new state arrives like any other change. */
  refresh(): Promise<void>;
}

const FREE_NOTICES: Record<string, LicenseNotice> = {
  license_device_revoked: "revoked",
  license_no_seat: "noSeat",
  license_checkout_timeout: "checkoutTimeout",
  license_unavailable: "unavailable",
};

/** The notice of a state: a free state carries its own; an active one is told by its freshness. */
export function noticeOf(state: LicenseState | null): LicenseNotice | null {
  if (!state) return null;
  if (state.state === "free") return state.notice ? (FREE_NOTICES[state.notice] ?? null) : null;
  switch (state.freshness.kind) {
    case "grace":
      return "grace";
    case "expired":
      return "expired";
    case "clockRollback":
      return "clock";
    default:
      return null;
  }
}

/** The license of this device: read once, then kept current by `license://changed`. */
export function useLicense(api: LicenseApi = defaultApi): License {
  const [state, setState] = useState<LicenseState | null>(null);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void api.onLicenseChanged((next) => live && setState(next)).then((off) => {
      if (live) stop = off;
      else off();
    });
    // The read after the listener is attached, so a change in between is not lost; an event that
    // already arrived is newer than this answer, so it stays.
    void api.licenseState().then(
      (s) => live && setState((now) => now ?? s),
      () => undefined,
    );
    return () => {
      live = false;
      stop?.();
    };
  }, [api]);

  const allows = useCallback((feature: string) => state?.state === "active" && state.features.includes(feature), [state]);
  const refresh = useCallback(
    () =>
      api.licenseRefresh().then(
        (s) => setState(s),
        () => undefined,
      ),
    [api],
  );
  return { state, plan: state?.state === "active" ? state.plan : [], allows, notice: noticeOf(state), refresh };
}
