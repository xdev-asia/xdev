// The feature tips: a list of short tips, one shown per launch in a small modal. Pure, so it tests without a DOM.

export type TipActionId = "install-cli-skill";

export interface Tip {
  id: string;
  titleKey: string;
  bodyKey: string;
  /** A line shown as an example, in monospace. */
  exampleKey?: string;
  /** A button that does something; the tip closes when it is done. */
  action?: { id: TipActionId; labelKey: string };
  /** Whether the tip applies now. A tip with no rule always applies. */
  when?(ctx: TipContext): boolean;
}

/** What the tips need to know about the app. A field that is null is not read yet. */
export interface TipContext {
  cliSkillInstalled: boolean | null;
}

export const CLI_SKILL_TIP = "cli-skill";

/** In the order they are offered. */
export const TIPS: readonly Tip[] = [
  {
    id: CLI_SKILL_TIP,
    titleKey: "tip.cliSkill.title",
    bodyKey: "tip.cliSkill.body",
    exampleKey: "tip.cliSkill.example",
    action: { id: "install-cli-skill", labelKey: "tip.cliSkill.install" },
    // An unknown status keeps it back: it is offered once the status is read, and only while the skill is missing.
    when: (ctx) => ctx.cliSkillInstalled === false,
  },
  { id: "layouts", titleKey: "tip.layouts.title", bodyKey: "tip.layouts.body" },
  { id: "review-notes", titleKey: "tip.reviewNotes.title", bodyKey: "tip.reviewNotes.body" },
  { id: "activity", titleKey: "tip.activity.title", bodyKey: "tip.activity.body" },
];

/** The first tip that applies and was not seen, or null. */
export function nextTip(tips: readonly Tip[], seen: ReadonlySet<string>, ctx: TipContext): Tip | null {
  return tips.find((t) => !seen.has(t.id) && (t.when?.(ctx) ?? true)) ?? null;
}

/**
 * Whether to open the tips modal now: tips are on, none showed this run or today, nothing else has the screen, the start
 * has settled, this is not the first launch, and there is at least one project to tip about.
 */
export function tipsGate(input: {
  enabled: boolean;
  shownThisRun: boolean;
  suppressed: boolean;
  settled: boolean;
  /** The launch number, counting from 1. */
  launch: number;
  /** The projects are read and there is at least one. */
  hasProject: boolean;
  /** A tip was shown earlier today. */
  shownToday: boolean;
}): boolean {
  return input.enabled && !input.shownThisRun && !input.suppressed && input.settled && input.launch > 1 && input.hasProject && !input.shownToday;
}

/** The calendar day of `date` in local time, `YYYY-MM-DD`. */
export function dayKey(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** How long after the start the app is left alone before a tip appears. */
export const SETTLE_MS = 4000;

// Storage. Injected so a test keeps its own copy.
export const TIPS_SEEN_KEY = "xdev.tips.seen";
export const TIPS_OFF_KEY = "xdev.tips.off";
/** The day (`YYYY-MM-DD`) a tip was last shown: at most one tip a day. */
export const TIPS_DAY_KEY = "xdev.tips.day";
/** How many times the app was launched. */
export const LAUNCHES_KEY = "xdev.launches";
/** The key the one-off CLI skill card used: "dismissed" counts as that tip seen. */
export const LEGACY_CLI_TIP_KEY = "xdev.tip.cliSkill";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const defaultStore = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

export function loadSeenTips(store: Store | null = defaultStore()): Set<string> {
  const seen = new Set<string>();
  try {
    const raw: unknown = JSON.parse(store?.getItem(TIPS_SEEN_KEY) ?? "[]");
    if (Array.isArray(raw)) for (const v of raw) if (typeof v === "string") seen.add(v);
    if (store?.getItem(LEGACY_CLI_TIP_KEY) === "dismissed") seen.add(CLI_SKILL_TIP);
  } catch {
    // Unreadable: nothing is seen, the tips may repeat.
  }
  return seen;
}

export function markTipSeen(id: string, store: Store | null = defaultStore()): void {
  try {
    const seen = loadSeenTips(store);
    seen.add(id);
    store?.setItem(TIPS_SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // The tip may come back next run.
  }
}

/** Whether a tip was shown on the same calendar day as `now`; false when storage cannot be read. */
export function tipShownOn(now: Date, store: Store | null = defaultStore()): boolean {
  try {
    return store?.getItem(TIPS_DAY_KEY) === dayKey(now);
  } catch {
    return false;
  }
}

export function markTipDay(now: Date, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(TIPS_DAY_KEY, dayKey(now));
  } catch {
    // A second tip may show today.
  }
}

/** Counts this launch and returns its number (1 on the first). Without storage every launch looks like a later one. */
export function countLaunch(store: Store | null = defaultStore()): number {
  try {
    if (!store) return 2;
    const n = Number.parseInt(store.getItem(LAUNCHES_KEY) ?? "0", 10);
    const next = (Number.isFinite(n) && n > 0 ? n : 0) + 1;
    store.setItem(LAUNCHES_KEY, String(next));
    return next;
  } catch {
    return 2;
  }
}

/** Tips are on unless the person turned them off; on when storage cannot be read. */
export function loadTipsEnabled(store: Store | null = defaultStore()): boolean {
  try {
    return store?.getItem(TIPS_OFF_KEY) !== "1";
  } catch {
    return true;
  }
}

/** Turning tips back on also forgets the seen ones, so the person gets tips to read again. */
export function saveTipsEnabled(enabled: boolean, store: Store | null = defaultStore()): void {
  try {
    if (enabled) {
      store?.removeItem(TIPS_OFF_KEY);
      store?.removeItem(TIPS_SEEN_KEY);
      store?.removeItem(LEGACY_CLI_TIP_KEY);
    } else store?.setItem(TIPS_OFF_KEY, "1");
  } catch {
    // Not stored: the choice lasts until the next start.
  }
}
