import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { TipsModalView } from "./TipsModal";
import { countLaunch, dayKey, markTipDay, tipShownOn, CLI_SKILL_TIP, LEGACY_CLI_TIP_KEY, loadSeenTips, loadTipsEnabled, markTipSeen, nextTip, saveTipsEnabled, TIPS, tipsGate } from "./tipsModel";

vi.mock("@/i18n", async (original) => ({ ...(await original<typeof import("@/i18n")>()), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const memory = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
};
const en = (key: string) => translate("en", key);

describe("which tip comes next", () => {
  const missing = { cliSkillInstalled: false };
  it("offers the first tip that applies and was not seen", () => {
    expect(nextTip(TIPS, new Set(), missing)?.id).toBe(CLI_SKILL_TIP);
    expect(nextTip(TIPS, new Set([CLI_SKILL_TIP]), missing)?.id).toBe("layouts");
  });
  it("holds the CLI skill tip back when the skill is installed or the status is unknown", () => {
    expect(nextTip(TIPS, new Set(), { cliSkillInstalled: true })?.id).toBe("layouts");
    expect(nextTip(TIPS, new Set(), { cliSkillInstalled: null })?.id).toBe("layouts");
  });
  it("is null when every tip was seen", () => {
    expect(nextTip(TIPS, new Set(TIPS.map((t) => t.id)), missing)).toBeNull();
  });
  it("has title and body text in English and Vietnamese, and one action at most", () => {
    for (const tip of TIPS)
      for (const key of [tip.titleKey, tip.bodyKey, ...(tip.exampleKey ? [tip.exampleKey] : []), ...(tip.action ? [tip.action.labelKey] : [])]) {
        expect(translate("en", key)).not.toBe(key);
        expect(translate("vi", key)).not.toBe(key);
      }
    expect(new Set(TIPS.map((t) => t.id)).size).toBe(TIPS.length);
  });
});

describe("the startup gate", () => {
  const open = { enabled: true, shownThisRun: false, suppressed: false, settled: true, launch: 2, hasProject: true, shownToday: false };
  it("opens when tips are on, none showed this run, nothing has the screen and the start settled", () => {
    expect(tipsGate(open)).toBe(true);
  });
  it("stays closed otherwise", () => {
    expect(tipsGate({ ...open, enabled: false })).toBe(false);
    expect(tipsGate({ ...open, shownThisRun: true })).toBe(false);
    expect(tipsGate({ ...open, suppressed: true })).toBe(false);
    expect(tipsGate({ ...open, settled: false })).toBe(false);
  });
  it("stays closed on the first launch, before a project exists, and after a tip today", () => {
    expect(tipsGate({ ...open, launch: 1 })).toBe(false);
    expect(tipsGate({ ...open, hasProject: false })).toBe(false);
    expect(tipsGate({ ...open, shownToday: true })).toBe(false);
  });
});

describe("one tip a day and the launch count", () => {
  it("remembers the calendar day a tip showed", () => {
    const store = memory();
    const morning = new Date(2026, 10, 6, 8, 0);
    expect(tipShownOn(morning, store)).toBe(false);
    markTipDay(morning, store);
    expect(tipShownOn(new Date(2026, 10, 6, 23, 59), store)).toBe(true);
    expect(tipShownOn(new Date(2026, 10, 7, 0, 1), store)).toBe(false);
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
  it("counts launches from 1, and treats unreadable storage as a later launch", () => {
    const store = memory();
    expect(countLaunch(store)).toBe(1);
    expect(countLaunch(store)).toBe(2);
    expect(countLaunch(memory({ "xdev.launches": "x" }))).toBe(1);
    expect(countLaunch(null)).toBe(2);
  });
});

describe("what is remembered", () => {
  it("remembers seen tips, and the old CLI card dismissal counts as that tip seen", () => {
    const store = memory();
    markTipSeen("layouts", store);
    expect([...loadSeenTips(store)]).toEqual(["layouts"]);
    expect(loadSeenTips(memory({ [LEGACY_CLI_TIP_KEY]: "dismissed" })).has(CLI_SKILL_TIP)).toBe(true);
    expect(loadSeenTips(memory({ "xdev.tips.seen": "{broken" })).size).toBe(0);
    expect(loadSeenTips(null).size).toBe(0);
  });
  it("turning tips off is kept, and turning them on forgets the seen ones", () => {
    const store = memory();
    expect(loadTipsEnabled(store)).toBe(true);
    saveTipsEnabled(false, store);
    expect(loadTipsEnabled(store)).toBe(false);
    markTipSeen("layouts", store);
    saveTipsEnabled(true, store);
    expect(loadTipsEnabled(store)).toBe(true);
    expect(loadSeenTips(store).size).toBe(0);
  });
});

describe("the modal", () => {
  type Node = { type?: unknown; props?: Record<string, any> };
  const buttons = (value: unknown): Node[] => {
    if (Array.isArray(value)) return value.flatMap(buttons);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const node = value as Node;
    return [...(node.type === Button ? [node] : []), ...buttons(node.props?.children)];
  };
  const handlers = () => ({ onAction: vi.fn(), onNext: vi.fn(), onDisable: vi.fn(), onClose: vi.fn() });
  const cli = TIPS[0]!;

  it("shows the tip, an example, and Next tip and Don't show tips", () => {
    const html = renderToStaticMarkup(<TipsModalView tip={cli} phase="idle" hasNext {...handlers()} />).replaceAll("&#x27;", "'");
    for (const key of ["tip.eyebrow", "tip.cliSkill.title", "tip.cliSkill.body", "tip.cliSkill.example", "tip.next", "tip.disable", "tip.cliSkill.install"]) expect(html).toContain(en(key));
    expect(html).toContain('aria-modal="true"');
  });
  it("hides Next tip when it was the last one, and offers Got it for a tip without an action", () => {
    const html = renderToStaticMarkup(<TipsModalView tip={TIPS[1]!} phase="idle" hasNext={false} {...handlers()} />);
    expect(html).not.toContain(en("tip.next"));
    expect(html).toContain(en("tip.close"));
  });
  it("the buttons call their handlers, all of type button, one primary", () => {
    const h = handlers();
    const view = TipsModalView({ tip: cli, phase: "idle", hasNext: true, ...h });
    const own = buttons(view.props.children);
    expect(own.map((b) => b.props?.children)).toEqual([en("tip.next"), en("tip.disable")]);
    for (const b of own) expect(b.props?.type).toBe("button");
    expect(own.every((b) => b.props?.variant === "secondary")).toBe(true);
    own[0]!.props?.onClick();
    own[1]!.props?.onClick();
    expect(h.onNext).toHaveBeenCalledTimes(1);
    expect(h.onDisable).toHaveBeenCalledTimes(1);
    expect(view.props.onConfirm).toBe(h.onAction);
    expect(view.props.onCancel).toBe(h.onClose);
  });
  it("installing disables the actions, and done shows Installed with the close button", () => {
    const busy = TipsModalView({ tip: cli, phase: "installing", hasNext: true, ...handlers() });
    expect(busy.props.confirmDisabled).toBe(true);
    expect(buttons(busy.props.children).every((b) => b.props?.disabled === true)).toBe(true);
    const h = handlers();
    const done = TipsModalView({ tip: cli, phase: "done", hasNext: true, ...h });
    expect(done.props.confirmLabel).toBe(en("tip.done"));
    expect(done.props.onConfirm).toBe(h.onClose);
  });
});
