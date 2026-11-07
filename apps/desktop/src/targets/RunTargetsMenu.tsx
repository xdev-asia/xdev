import { useEffect, useState } from "react";
import type { MenuEntry } from "@xdev-asia/ui";
import type { Api, DeployPreset, TargetsView } from "@/api";
import { deployEntries, isEmpty, needsTrust, serverEntry } from "./targetsModel";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Reads the worktree's run targets each time a `+` menu opens (`open` changes to non-null); null while loading. */
export function useMenuTargets(api: Pick<Api, "targetsList">, worktree: string, open: string | null): TargetsView | null {
  const [view, setView] = useState<TargetsView | null>(null);
  useEffect(() => {
    if (open === null) return;
    let live = true;
    void Promise.resolve()
      .then(() => api.targetsList(worktree))
      .then((v) => live && setView(v))
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [api, worktree, open]);
  return view;
}

/**
 * The "Run targets" section of the `+` menu: deploy presets, the server shell, and a way to review
 * `xdev.toml` first. A hint is a disabled entry. `view` is null while loading: the title alone.
 */
export function runTargetEntries(
  view: TargetsView | null,
  t: T,
  on: { deploy(preset: DeployPreset): void; server(view: TargetsView): void; review(view: TargetsView): void },
): MenuEntry[] {
  const out: MenuEntry[] = [{ type: "group", label: t("targets.menu.title") }];
  if (!view) return out;
  if (isEmpty(view)) out.push({ label: t("targets.deploy.none"), disabled: true });
  const deploy = deployEntries(view);
  if (deploy.length > 0) {
    out.push({ type: "group", label: t("targets.deploy.group") });
    for (const e of deploy) {
      const source = t(e.preset.source === "repo" ? "targets.source.repo" : "targets.source.detected");
      out.push({ label: `${e.preset.name} · ${source}`, disabled: e.disabled !== null, onSelect: () => on.deploy(e.preset) });
    }
  }
  const server = serverEntry(view);
  if (server) {
    out.push({ type: "group", label: t("targets.server.group") });
    out.push({ label: `${t("targets.server.open")} · ${server.vps.host}`, disabled: server.disabled !== null, onSelect: () => on.server(view) });
    if (!server.hostKnown) out.push({ label: t("targets.vps.noHost", { host: server.vps.host }), disabled: true });
  }
  if (needsTrust(view)) {
    out.push({ label: t("targets.untrusted.hint"), disabled: true });
    out.push({ label: t("targets.untrusted.review"), onSelect: () => on.review(view) });
  }
  return out;
}
