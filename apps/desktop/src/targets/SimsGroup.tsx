import { useEffect, useState } from "react";
import type { MenuEntry } from "@xdev-asia/ui";
import type { Api, SimDevice, SimList } from "@/api";
import { simGroups, simsEmpty } from "./simsModel";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Lists the simulators each time a `+` menu opens (`open` changes to non-null); null while loading. */
export function useMenuSims(api: Pick<Api, "simsList">, open: string | null): SimList | null {
  const [list, setList] = useState<SimList | null>(null);
  useEffect(() => {
    if (open === null) return;
    let live = true;
    setList(null);
    void Promise.resolve()
      .then(() => api.simsList())
      .then((l) => live && setList(l))
      .catch(() => live && setList({ ios: null, android: null, problems: [] }));
    return () => {
      live = false;
    };
  }, [api, open]);
  return list;
}

/** The Simulators entries of the `+` menu for a loaded `list` (null while loading). A hint is a disabled entry. */
export function simEntries(list: SimList | null, t: T, onPick: (device: SimDevice) => void): MenuEntry[] {
  const out: MenuEntry[] = [{ type: "group", label: t("targets.sim") }];
  if (!list) return [...out, { label: t("targets.sim.loading"), disabled: true }];
  if (simsEmpty(list)) out.push({ label: t(list.ios === null && !list.problems.includes("targets.sim.noXcode") ? "targets.sim.noneAndroid" : "targets.sim.none"), disabled: true });
  for (const g of simGroups(list, t)) {
    out.push({ type: "group", label: t(g.titleKey) });
    for (const row of g.rows) out.push({ label: `${row.label} · ${t(row.action === "boot" ? "targets.sim.boot" : "targets.sim.logs")}`, onSelect: () => onPick(row.device) });
  }
  for (const key of list.problems) out.push({ label: t(key), disabled: true });
  return out;
}
