import type { DeployPreset, TargetsView, VpsTarget } from "@/api";

export type DisabledReason = "untrusted";

export type DeployEntry = { preset: DeployPreset; disabled: DisabledReason | null };

export type ServerEntry = { vps: VpsTarget; disabled: DisabledReason | null; hostKnown: boolean };

/** There is something from `xdev.toml` still to review. */
export function needsTrust(view: TargetsView): boolean {
  return !view.trusted && view.hash !== "";
}

/** The deploy presets in menu order. A preset from the repo's file waits for trust; a detected one does not. */
export function deployEntries(view: TargetsView): DeployEntry[] {
  return view.deploy.map((preset) => ({
    preset,
    disabled: preset.source === "repo" && !view.trusted ? "untrusted" : null,
  }));
}

/** The server shell entry; null without a `[vps]`. It comes from the repo's file, so it waits for trust too. */
export function serverEntry(view: TargetsView): ServerEntry | null {
  if (!view.vps) return null;
  return { vps: view.vps, disabled: view.trusted ? null : "untrusted", hostKnown: view.vpsHostKnown };
}

/** Whether the menu has nothing to offer at all. */
export function isEmpty(view: TargetsView): boolean {
  return view.deploy.length === 0 && view.vps === null;
}

/** `text` as one POSIX shell word. */
export function shellQuote(text: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

/** The line typed after an SSH tab starts: go to the server's project folder. Null without a `cwd`. */
export function cdLine(vps: VpsTarget): string | null {
  return vps.cwd ? `cd ${shellQuote(vps.cwd)}` : null;
}
