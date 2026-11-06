import type { SimDevice, SimList, SimState } from "@/api";

type T = (key: string, vars?: Record<string, string | number>) => string;

export type SimRow = {
  device: SimDevice;
  /** "iPhone 16 · iOS 18.0 · Running" */
  label: string;
  running: boolean;
  /** What picking the row does: start the device and stream logs, or only stream logs. */
  action: "boot" | "logs";
};

export type SimGroupView = { key: "ios" | "android"; titleKey: string; rows: SimRow[] };

const STATE_KEY: Record<SimState, string> = {
  booted: "targets.sim.booted",
  shutdown: "targets.sim.shutdown",
  unknown: "targets.sim.unknown",
};

/** The row text: name, runtime when known, state. */
export function simLabel(device: SimDevice, t: T): string {
  return [device.name, device.runtime, t(STATE_KEY[device.state])].filter((p): p is string => !!p).join(" · ");
}

export function simRow(device: SimDevice, t: T): SimRow {
  const running = device.state === "booted";
  return { device, label: simLabel(device, t), running, action: running ? "logs" : "boot" };
}

/** iOS then Android groups; a platform with no devices (or a missing tool) has no group. */
export function simGroups(list: SimList, t: T): SimGroupView[] {
  const groups: SimGroupView[] = [
    { key: "ios", titleKey: "targets.sim.ios", rows: (list.ios ?? []).map((d) => simRow(d, t)) },
    { key: "android", titleKey: "targets.sim.android", rows: (list.android ?? []).map((d) => simRow(d, t)) },
  ];
  return groups.filter((g) => g.rows.length > 0);
}

/** Nothing to pick: no devices on either platform. */
export function simsEmpty(list: SimList): boolean {
  return (list.ios ?? []).length === 0 && (list.android ?? []).length === 0;
}

/** The title of the log tab. */
export function logTabTitle(device: SimDevice, t: T): string {
  return t("targets.sim.logTab", { name: device.name });
}
