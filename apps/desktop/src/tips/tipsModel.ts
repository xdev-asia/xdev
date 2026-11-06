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

/** Whether to open the tips modal now: tips are on, none showed this run, nothing else has the screen, and the start has settled. */
export function tipsGate(input: { enabled: boolean; shownThisRun: boolean; suppressed: boolean; settled: boolean }): boolean {
  return input.enabled && !input.shownThisRun && !input.suppressed && input.settled;
}

/** How long after the start the app is left alone before a tip appears. */
export const SETTLE_MS = 4000;

// Storage. Injected so a test keeps its own copy.
export const TIPS_SEEN_KEY = "xdev.tips.seen";
export const TIPS_OFF_KEY = "xdev.tips.off";
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
