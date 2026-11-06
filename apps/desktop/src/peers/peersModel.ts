import { toApiError, type PeerKind, type PeerRole, type PeerTermState, type PeerView } from "@/api";

type T = (key: string, vars?: Record<string, string | number>) => string;

const RANK: Record<PeerRole, number> = { none: 0, viewer: 1, operator: 2, admin: 3 };

/** True when `role` is at least `need`; a missing role is `none`. */
export function atLeast(role: PeerRole | null | undefined, need: PeerRole): boolean {
  return RANK[role ?? "none"] >= RANK[need];
}

/** The roles a computer of this kind can be given: a phone is a Viewer or an Operator, never Admin. */
export function rolesFor(kind: PeerKind): PeerRole[] {
  return kind === "phone" ? ["viewer", "operator"] : ["none", "viewer", "operator", "admin"];
}

/** Admin can run any command, so choosing it asks first. */
export function needsAdminConfirm(role: PeerRole): boolean {
  return role === "admin";
}

/** The "Give Admin" button is on only when the computer's name was typed in full. */
export function adminNameMatches(typed: string, name: string): boolean {
  return typed.trim() === name;
}

/** What a role means, for the line under a role picker. */
export function roleDetailKey(role: PeerRole): string | null {
  return role === "none" ? null : `peers.role.${role}.detail`;
}

/** "4:59": minutes and zero padded seconds; never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const s = total % 60;
  return `${Math.floor(total / 60)}:${s < 10 ? "0" : ""}${s}`;
}

/** "5 minutes ago": a coarse relative time for the Last seen line. */
export function relativeTime(thenMs: number, nowMs: number, locale: string): string {
  const seconds = Math.round((thenMs - nowMs) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}

/** The words of a failure: the peers.error text of the code, else the generic error text. */
export function errorText(t: T, e: unknown, name = ""): string {
  return codeText(t, toApiError(e).code, name);
}

/** The words of an error code that came as a string, such as the `error` of `peers://pair-result`. */
export function codeText(t: T, code: string, name = ""): string {
  const own = `peers.error.${code}`;
  const text = t(own, { name });
  if (text !== own) return text;
  const generic = `error.${code}`;
  const g = t(generic, { name });
  return g !== generic ? g : t("peers.error.other");
}

/** Online computers first, then by name. */
export function sortPeers(peers: readonly PeerView[]): PeerView[] {
  return [...peers].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** The StatusDot tone of an agent state. */
export function stateTone(state: PeerTermState): "ok" | "warn" | "danger" | "accent" | "neutral" {
  switch (state) {
    case "running":
      return "accent";
    case "needs_input":
      return "warn";
    case "error":
      return "danger";
    case "done":
      return "ok";
    default:
      return "neutral";
  }
}

/** The toast text of a peer's activity: typed, started, closed, handed off, or the raw action. */
export function activityText(t: T, ev: { peer: string; action: string; target: string }): string {
  const vars = { computer: ev.peer, tab: ev.target };
  switch (ev.action) {
    case "typed":
      return t("peers.activity.typed", vars);
    case "killed":
      return t("peers.activity.killed", vars);
    case "started":
      return t("peers.activity.startedTab", vars);
    case "handed_off":
      return t("peers.activity.handedOff", vars);
    default:
      return t("peers.activity.other", { ...vars, action: ev.action });
  }
}

/** The words of what a computer asks to do: a known action is translated, else shown as it came. */
export function confirmAction(t: T, action: string): string {
  const key = `peers.confirm.action.${action}`;
  const text = t(key);
  return text === key ? action : text;
}
