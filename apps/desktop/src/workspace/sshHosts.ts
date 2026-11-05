import { useEffect, useState } from "react";
import type { Api } from "@/api";
import { SSH_SHELL_PREFIX } from "@/agents/profileStore";

/** The terminal profile ids of the saved SSH hosts, one per alias, in the order they were saved. */
export function sshProfiles(aliases: readonly string[]): string[] {
  return aliases.map((a) => `${SSH_SHELL_PREFIX}${a}`);
}

/**
 * The aliases of the saved SSH hosts, read again each time `refresh` changes (the `+` menu opening),
 * so a host added in Settings shows without a restart. Empty while loading or when the read fails.
 */
export function useSshAliases(api: Pick<Api, "sshHostsList">, refresh: unknown): string[] {
  const [aliases, setAliases] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    // A throw from a missing method becomes a rejection, so it reads as "no hosts".
    void Promise.resolve()
      .then(() => api.sshHostsList())
      .then((hosts) => live && setAliases(hosts.map((h) => h.alias)))
      .catch(() => live && setAliases([]));
    return () => {
      live = false;
    };
  }, [api, refresh]);
  return aliases;
}
