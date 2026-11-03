import { useEffect, useState } from "react";
import type { Api, Quota } from "@/api";

const REFRESH_MS = 300_000;

/** Quota for the status bar; `null` until read, or when it cannot be read. */
export function useQuota(api: Api, paused: boolean): Quota[] | null {
  const [quota, setQuota] = useState<Quota[] | null>(null);
  useEffect(() => {
    // The Accounts view polls on its own. Leaving it reads again, since the person may have signed in there.
    if (paused) return;
    let stale = false;
    const load = () =>
      api.quota().then(
        (found) => !stale && setQuota(found),
        () => !stale && setQuota(null),
      );
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [api, paused]);
  return quota;
}
