import type { HostEnvVar, HostSettings } from "@/api";

/** The page's editable copy of one host's overrides: text fields, "" = use the default. */
export interface HostForm {
  label: string;
  shell: string;
  env: HostEnvVar[];
  /** "default" | "on" | "off". */
  history: "default" | "on" | "off";
  claudeHome: string;
  codexHome: string;
  days: string;
}

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV = 64;

export function toForm(s: HostSettings): HostForm {
  const h = s.history;
  return {
    label: s.label ?? "",
    shell: s.shell ?? "",
    env: s.env.map((v) => ({ ...v })),
    history: h.enabled === null ? "default" : h.enabled ? "on" : "off",
    claudeHome: h.claudeHome ?? "",
    codexHome: h.codexHome ?? "",
    days: h.days === null ? "" : String(h.days),
  };
}

const text = (v: string): string | null => (v.trim() === "" ? null : v.trim());

/** The settings to store. A blank field becomes null (use the default); an unparsable number too. */
export function fromForm(f: HostForm): HostSettings {
  const days = Number(f.days.trim());
  return {
    label: text(f.label),
    shell: text(f.shell),
    env: f.env.filter((v) => v.name.trim() !== "").map((v) => ({ name: v.name.trim(), value: v.value })),
    history: {
      enabled: f.history === "default" ? null : f.history === "on",
      claudeHome: text(f.claudeHome),
      codexHome: text(f.codexHome),
      days: f.days.trim() !== "" && Number.isInteger(days) ? days : null,
    },
  };
}

/** The names of env rows that are not valid variable names. */
export function badEnvRows(env: readonly HostEnvVar[]): number[] {
  return env.flatMap((v, i) => (v.name.trim() !== "" && !ENV_NAME.test(v.name.trim()) ? [i] : []));
}

/** True when `days` is blank or a whole number in 1..=3650. */
export function daysOk(days: string): boolean {
  const d = days.trim();
  if (d === "") return true;
  const n = Number(d);
  return Number.isInteger(n) && n >= 1 && n <= 3650;
}

/** The top-level keys that differ; "use default" for one key changes only that key. */
export function changedKeys(a: HostSettings, b: HostSettings): ("label" | "shell" | "env" | "history")[] {
  return (["label", "shell", "env", "history"] as const).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** `base` with the `keys` of `next` applied, so one save carries only what the user changed. */
export function patch(base: HostSettings, next: HostSettings, keys: readonly ("label" | "shell" | "env" | "history")[]): HostSettings {
  const out: HostSettings = { ...base, history: { ...base.history }, env: base.env.map((v) => ({ ...v })) };
  for (const k of keys) (out as unknown as Record<string, unknown>)[k] = next[k];
  return out;
}
