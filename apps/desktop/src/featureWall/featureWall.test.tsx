import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { FeatureWallView } from "./FeatureWall";
import { compareVersions, loadWallSeen, releasesFor, saveWallSeen, unseenReleases, wallStart, WALL_SEEN_KEY } from "./featureWallModel";
import { closeFeatureWall, onTryFeature, openFeatureWall, rememberWallVersion, resetWallForTests, setWallVersion, tryFeature, wallHasNew } from "./featureWallStore";
import { RELEASES, type Release } from "./releases";

vi.mock("@/i18n", async (original) => ({ ...(await original<typeof import("@/i18n")>()), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const memory = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
};
const en = (key: string) => translate("en", key);
const rel = (version: string): Release => ({ version, cards: [{ id: "a", titleKey: "wall.tours.title", bodyKey: "wall.tours.body" }] });

describe("versions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("v0.8", "0.8.0")).toBe(0);
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(0);
    expect(compareVersions("junk", "0.0.1")).toBeLessThan(0);
  });
});

describe("which releases show", () => {
  const all = [rel("0.7.0"), rel("0.8.0"), rel("0.9.0"), { version: "0.8.5", cards: [] }];
  it("lists releases up to the running version with cards, newest first", () => {
    expect(releasesFor(all, "0.8.2").map((r) => r.version)).toEqual(["0.8.0", "0.7.0"]);
  });
  it("keeps the unseen ones", () => {
    expect(unseenReleases(all, "0.9.0", "0.7.0").map((r) => r.version)).toEqual(["0.9.0", "0.8.0"]);
    expect(unseenReleases(all, "0.9.0", "0.9.0")).toEqual([]);
    expect(unseenReleases(all, "0.8.0", null)).toHaveLength(2);
  });
  it("opens after an update, remembers on a first run, stays quiet when seen", () => {
    const base = { releases: all, appVersion: "0.8.0" };
    expect(wallStart({ ...base, seen: "0.7.0", firstRun: false })).toBe("open");
    expect(wallStart({ ...base, seen: null, firstRun: true })).toBe("remember");
    expect(wallStart({ ...base, seen: "0.8.0", firstRun: false })).toBe("none");
    expect(wallStart({ ...base, seen: "0.8.0", firstRun: true })).toBe("none");
  });
});

describe("what is remembered", () => {
  it("keeps the newest seen version and never goes back", () => {
    const store = memory();
    expect(loadWallSeen(store)).toBeNull();
    saveWallSeen("0.8.0", store);
    saveWallSeen("0.7.0", store);
    expect(loadWallSeen(store)).toBe("0.8.0");
    expect(store.getItem(WALL_SEEN_KEY)).toBe("0.8.0");
    expect(loadWallSeen(null)).toBeNull();
  });
});

describe("the store", () => {
  beforeEach(() => {
    resetWallForTests();
  });
  it("shows a dot until the wall opens, then not", () => {
    const state = () => ({ open: false, appVersion: "0.9.0" as string | null, seen: null as string | null });
    expect(wallHasNew({ ...state(), appVersion: null })).toBe(false);
    expect(wallHasNew({ ...state(), seen: "0.0.1" })).toBe(true);
    expect(wallHasNew({ ...state(), seen: "99.0.0" })).toBe(false);
  });
  it("opens, closes and passes a Try it to the listener", () => {
    setWallVersion("0.7.0");
    openFeatureWall();
    closeFeatureWall();
    rememberWallVersion("0.7.0");
    const seen: unknown[] = [];
    const off = onTryFeature((t) => seen.push(t));
    tryFeature({ kind: "activity" });
    off();
    tryFeature({ kind: "activity" });
    expect(seen).toEqual([{ kind: "activity" }]);
  });
});

describe("the release data", () => {
  it("has text in English and Vietnamese for every card, and unique ids", () => {
    for (const r of RELEASES) {
      expect(new Set(r.cards.map((c) => c.id)).size).toBe(r.cards.length);
      for (const c of r.cards)
        for (const key of [c.titleKey, c.bodyKey]) {
          expect(translate("en", key)).not.toBe(key);
          expect(translate("vi", key)).not.toBe(key);
        }
    }
    expect(new Set(RELEASES.map((r) => r.version)).size).toBe(RELEASES.length);
  });
});

describe("the wall", () => {
  type Node = { type?: unknown; props?: Record<string, any> };
  const buttons = (value: unknown): Node[] => {
    if (Array.isArray(value)) return value.flatMap(buttons);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const node = value as Node;
    return [...(node.type === Button ? [node] : []), ...buttons(node.props?.children), ...buttons(node.props?.actions)];
  };
  const releases: Release[] = [{ version: "0.8.0", cards: [{ id: "a", titleKey: "wall.tips.title", bodyKey: "wall.tips.body", tryIt: { kind: "settings", section: "general" } }, { id: "b", titleKey: "wall.tours.title", bodyKey: "wall.tours.body" }] }];

  it("shows the release, the cards and Close", () => {
    const html = renderToStaticMarkup(<FeatureWallView releases={releases} onTry={() => {}} onClose={() => {}} />).replaceAll("&#x27;", "'");
    for (const key of ["wall.title", "wall.close", "wall.tips.title", "wall.tips.body", "wall.tours.title", "wall.try"]) expect(html).toContain(en(key));
    expect(html).toContain("Version 0.8.0");
    expect(html).toContain('aria-modal="true"');
    expect(html.split(en("wall.try")).length - 1).toBe(1);
  });
  it("Try it hands over the card's target and is a quiet button of type button", () => {
    const onTry = vi.fn();
    const view = FeatureWallView({ releases, onTry, onClose: () => {} });
    const own = buttons(view.props.children);
    expect(own).toHaveLength(1);
    expect(own[0]!.props?.type).toBe("button");
    expect(own[0]!.props?.variant).toBe("secondary");
    own[0]!.props?.onClick();
    expect(onTry).toHaveBeenCalledWith({ kind: "settings", section: "general" });
  });
});
