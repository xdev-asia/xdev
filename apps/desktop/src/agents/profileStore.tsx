import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { Api, ProfilesView } from "@/api";

type Store = {
  view: ProfilesView | null;
  update(next: ProfilesView): void;
  reload(): Promise<void>;
};

// Without a provider the view stays null, so names and letters fall back to the built-ins.
const Ctx = createContext<Store>({ view: null, update: () => {}, reload: async () => {} });

/** Loads the profile view once and hands it, with an updater, to everything below. */
export function ProfilesProvider({ api, children }: { api: Api; children: ReactNode }): JSX.Element {
  const [view, setView] = useState<ProfilesView | null>(null);
  const reload = useCallback(async () => {
    try {
      setView(await api.profiles());
    } catch {
      // Names fall back to the built-ins until a later reload works.
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const value = useMemo(() => ({ view, update: setView, reload }), [view, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProfiles(): Store {
  return useContext(Ctx);
}

const BUILTIN_LETTER: Record<string, string> = { claude: "C", codex: "X", gemini: "G" };

/** The name of a profile or shell; the built-in label when the view is missing or lacks the id. */
export function profileName(
  view: ProfilesView | null,
  id: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const found = view?.profiles.find((p) => p.profile.id === id)?.profile.name ?? view?.shells.find((s) => s.id === id)?.name;
  return found ?? t(`terminal.profile.${id}`);
}

/** The letter on a profile's mark: `S` for shells, `C`/`X`/`G` for built-ins, else the first letter. */
export function profileLetter(view: ProfilesView | null, id: string): string {
  if (id.startsWith("shell")) return "S";
  if (BUILTIN_LETTER[id]) return BUILTIN_LETTER[id];
  const name = view?.profiles.find((p) => p.profile.id === id)?.profile.name ?? id;
  return (name.trim()[0] ?? id[0] ?? "?").toUpperCase();
}
