import type { MenuEntry } from "@xdev-asia/ui";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The `+` menu entries of a local project: run on its remote target, or set one. `alias` is null with no target. */
export function remoteTargetEntries(alias: string | null, t: T, on: { agent(): void; shell(): void; set(): void }): MenuEntry[] {
  return [
    { type: "group", label: t("remote.sidebar.group") },
    ...(alias !== null
      ? [
          { label: t("remote.plus.agent", { host: alias }), onSelect: on.agent },
          { label: t("remote.plus.shell", { host: alias }), onSelect: on.shell },
        ]
      : []),
    { label: t("remote.target.set"), onSelect: on.set },
  ];
}
