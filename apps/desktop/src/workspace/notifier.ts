import type { Api, StatusSettings } from "@/api";
import type { useI18n } from "@/i18n";
import type { Attention, Tab } from "./sessions";

type T = ReturnType<typeof useI18n>["t"];

/** One OS notification and one sound per pane and state this often at most (a burst says it once). */
export const COOLDOWN_MS = 5000;
/** The taskbar badge waits this long for the count to settle. */
export const BADGE_DEBOUNCE_MS = 200;
/** A window focus this soon after a notification is taken as a click on it. */
export const FOCUS_JUMP_MS = 15000;

export interface NotifierDeps {
  api: Pick<Api, "statusNotify" | "statusBadge">;
  /** The settings as stored now, read before each channel fires so a change in Settings applies at once. */
  settings(): Promise<StatusSettings>;
  /** Plays the status sound; true when it played (the player keeps its own 2 s floor). */
  play(settings: StatusSettings, now: number): Promise<boolean>;
  now(): number;
  t: T;
}

/** Names for the notification text. Never the prompt: the tab name is the profile's, or one given by hand. */
export interface NoticeNames {
  worktree: string;
  tab: string;
}

export interface Notifier {
  /** A pane nobody looks at reached a state that asks for the person: OS notification, then sound. */
  attention(tab: Tab, status: Attention, names: NoticeNames): Promise<void>;
  /** The count of unread tabs; sent to the taskbar after `BADGE_DEBOUNCE_MS`, as 0 while the badge is off. */
  badge(count: number): void;
  /** The newest notification that reached the OS. */
  lastNotified(): { ptyId: string; at: number } | null;
  /** The pane of a notification sent within `FOCUS_JUMP_MS` of `now`, once; later calls get null. */
  takeFocusJump(now: number): string | null;
  /** The person did something in the app, so the next focus is not a click on a notification. */
  cancelFocusJump(): void;
  dispose(): void;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const recent = new Map<string, number>();
  let newest: { ptyId: string; at: number } | null = null;
  let jump: { ptyId: string; at: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sentBadge: number | null = null;
  let disposed = false;

  async function attention(tab: Tab, status: Attention, names: NoticeNames): Promise<void> {
    const at = deps.now();
    for (const [key, when] of recent) if (at - when >= COOLDOWN_MS) recent.delete(key);
    const key = `${tab.id}:${status}`;
    if (recent.has(key)) return;
    // Taken before the first await, so a burst arriving together is told once.
    recent.set(key, at);
    const settings = await deps.settings();
    if (disposed) return;
    let sent = false;
    if (settings.os) {
      try {
        await deps.api.statusNotify(names.worktree, deps.t(`status.notify.${status}`, { name: names.tab }), tab.id);
        sent = true;
        newest = jump = { ptyId: tab.id, at };
      } catch {
        // Best effort: the bell and the badge still say it.
      }
    }
    // A sound goes with the OS notification it belongs to; with that channel off it goes alone.
    if (settings.sound && (!settings.os || sent)) await deps.play(settings, at).catch(() => false);
  }

  function badge(count: number): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void deps.settings().then((settings) => {
        const next = settings.badge ? count : 0;
        if (disposed || next === sentBadge) return;
        sentBadge = next;
        return deps.api.statusBadge(next).catch(() => {});
      });
    }, BADGE_DEBOUNCE_MS);
  }

  return {
    attention,
    badge,
    lastNotified: () => newest,
    takeFocusJump(now) {
      const found = jump && now - jump.at <= FOCUS_JUMP_MS ? jump.ptyId : null;
      jump = null;
      return found;
    },
    cancelFocusJump() {
      jump = null;
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
