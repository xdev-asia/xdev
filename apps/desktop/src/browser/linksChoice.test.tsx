import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@xdev-asia/ui";
import type { BrowserSettings } from "@/api";
import { translate } from "@/i18n";
import { openUrlLink, type LinkDeps } from "@/terminal/linkMenu";
import { BROWSER_DEFAULTS, getBrowserSettings, resetBrowserSettingsForTests, setBrowserSettings } from "./browserSettings";
import { LinksChoiceView } from "./LinksChoiceDialog";
import { answerLinksChoice, askLinksTarget, LINKS_ASKED_KEY, loadLinksAsked, needsLinksChoice, resetLinksChoiceForTests } from "./linksChoice";

vi.mock("@/i18n", async (original) => ({ ...(await original<typeof import("@/i18n")>()), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
};
const apiWith = () => ({ browserSettingsPut: vi.fn(async (s: BrowserSettings) => s) });
const KEYS = ["linksChoice.title", "linksChoice.body", "linksChoice.pane", "linksChoice.system", "linksChoice.hint"];

beforeEach(() => {
  resetBrowserSettingsForTests();
  resetLinksChoiceForTests();
});

describe("when the question is due", () => {
  it("only with the default setting and no answer before", () => {
    expect(needsLinksChoice("system", false)).toBe(true);
    expect(needsLinksChoice("system", true)).toBe(false);
    expect(needsLinksChoice("pane", false)).toBe(false);
  });
});

describe("asking", () => {
  it("writes the choice to the setting and remembers it, so the question comes once", async () => {
    const store = memory();
    const api = apiWith();
    const asked = askLinksTarget(api, store);
    answerLinksChoice("pane");
    expect(await asked).toEqual({ kind: "chosen", target: "pane" });
    expect(api.browserSettingsPut).toHaveBeenCalledWith({ ...BROWSER_DEFAULTS, openLinksIn: "pane" });
    expect(getBrowserSettings().openLinksIn).toBe("pane");
    expect(loadLinksAsked(store)).toBe(true);
    expect(await askLinksTarget(api, store)).toEqual({ kind: "skip" });
  });
  it("choosing the system browser also stops the question", async () => {
    const store = memory();
    const asked = askLinksTarget(apiWith(), store);
    answerLinksChoice("system");
    expect(await asked).toEqual({ kind: "chosen", target: "system" });
    expect(await askLinksTarget(apiWith(), store)).toEqual({ kind: "skip" });
  });
  it("closing the dialog answers nothing and the question comes again", async () => {
    const store = memory();
    const api = apiWith();
    const asked = askLinksTarget(api, store);
    answerLinksChoice(null);
    expect(await asked).toEqual({ kind: "cancel" });
    expect(api.browserSettingsPut).not.toHaveBeenCalled();
    expect(loadLinksAsked(store)).toBe(false);
  });
  it("a second click while the question is open joins the same dialog", async () => {
    const api = apiWith();
    const a = askLinksTarget(api, memory());
    const b = askLinksTarget(api, memory());
    answerLinksChoice("pane");
    expect((await a).kind).toBe("chosen");
    expect((await b).kind).toBe("chosen");
  });
  it("a setting the person already chose counts as the answer", async () => {
    setBrowserSettings({ ...BROWSER_DEFAULTS, openLinksIn: "pane" });
    const store = memory();
    expect(await askLinksTarget(apiWith(), store)).toEqual({ kind: "skip" });
    expect(store.getItem(LINKS_ASKED_KEY)).toBe("1");
  });
  it("a failed save still follows the choice for this click and asks again later", async () => {
    const store = memory();
    const asked = askLinksTarget({ browserSettingsPut: vi.fn(async () => Promise.reject(new Error("x"))) }, store);
    answerLinksChoice("pane");
    expect(await asked).toEqual({ kind: "chosen", target: "pane" });
    expect(loadLinksAsked(store)).toBe(false);
  });
});

describe("the click", () => {
  type Answer = Awaited<ReturnType<NonNullable<LinkDeps["askTarget"]>>>;
  const make = (answer: Answer, setting: "system" | "pane" = "system") => {
    const to: { url: string; keepFocus: boolean }[] = [];
    const askTarget = vi.fn(async () => answer);
    const d = {
      api: { openUrl: vi.fn(async () => {}) },
      toast: vi.fn(),
      t: (k: string) => k,
      openInPane: (url: string, keepFocus: boolean) => void to.push({ url, keepFocus }),
      linksTarget: () => setting,
      askTarget,
    } as unknown as LinkDeps;
    return { d, to, askTarget };
  };
  it("follows the answer: the app tab", async () => {
    const { d, to } = make({ kind: "chosen", target: "pane" });
    await openUrlLink("https://x.dev/", d);
    expect(to).toEqual([{ url: "https://x.dev/", keepFocus: false }]);
    expect(d.api.openUrl).not.toHaveBeenCalled();
  });
  it("follows the answer: the system browser", async () => {
    const { d, to } = make({ kind: "chosen", target: "system" });
    await openUrlLink("https://x.dev/", d);
    expect(d.api.openUrl).toHaveBeenCalledWith("https://x.dev/");
    expect(to).toEqual([]);
  });
  it("opens nothing when the dialog was closed", async () => {
    const { d, to } = make({ kind: "cancel" });
    await openUrlLink("https://x.dev/", d);
    expect(d.api.openUrl).not.toHaveBeenCalled();
    expect(to).toEqual([]);
  });
  it("uses the setting when nothing was asked, and Shift inverts it without asking", async () => {
    const skip = make({ kind: "skip" }, "pane");
    await openUrlLink("https://x.dev/", skip.d);
    expect(skip.to).toHaveLength(1);
    const shifted = make({ kind: "chosen", target: "pane" });
    await openUrlLink("https://x.dev/", shifted.d, true);
    expect(shifted.askTarget).not.toHaveBeenCalled();
    expect(shifted.to).toEqual([{ url: "https://x.dev/", keepFocus: true }]);
  });
  it("does not ask for a link that is not a web link", async () => {
    const { d, askTarget } = make({ kind: "chosen", target: "pane" });
    await openUrlLink("mailto:a@x.dev", d);
    expect(askTarget).not.toHaveBeenCalled();
    expect(d.api.openUrl).toHaveBeenCalled();
  });
  it("a failing question falls back to the setting", async () => {
    const { d } = make({ kind: "skip" });
    d.askTarget = () => Promise.reject(new Error("x"));
    await openUrlLink("https://x.dev/", d);
    expect(d.api.openUrl).toHaveBeenCalled();
  });
});

describe("the dialog", () => {
  type Node = { type?: unknown; props?: Record<string, any> };
  const buttons = (value: unknown): Node[] => {
    if (Array.isArray(value)) return value.flatMap(buttons);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const node = value as Node;
    return [...(node.type === Button ? [node] : []), ...buttons(node.props?.children)];
  };
  it("names both places and is modal", () => {
    const html = renderToStaticMarkup(<LinksChoiceView onChoose={() => {}} onCancel={() => {}} />).replaceAll("&#x27;", "'");
    for (const key of KEYS) expect(html).toContain(translate("en", key));
    expect(html).toContain('aria-modal="true"');
  });
  it("each button answers with its place, Esc answers nothing", () => {
    const onChoose = vi.fn();
    const onCancel = vi.fn();
    const view = LinksChoiceView({ onChoose, onCancel });
    const own = buttons(view.props.children);
    expect(own).toHaveLength(1);
    expect(own[0]!.props?.type).toBe("button");
    expect(own[0]!.props?.variant).toBe("secondary");
    own[0]!.props?.onClick();
    view.props.onConfirm();
    view.props.onCancel();
    expect(onChoose.mock.calls).toEqual([["system"], ["pane"]]);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
  it("has both languages", () => {
    for (const key of KEYS) {
      expect(translate("en", key)).not.toBe(key);
      expect(translate("vi", key)).not.toBe(key);
    }
  });
});
