import { describe, expect, it } from "vitest";
import { translate, type Locale } from "@/i18n";
import { localDay } from "./kitUi";
import { SHARE_COLORS, shareCardSvg, shareText, type ShareCardData, type ShareColor } from "./shareCard";

const tr = (locale: Locale) => (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars);
const tk = (input: number) => ({ input, output: 0, cache_read: 0, cache_write: 0 });

const data: ShareCardData = {
  provider: "claude",
  range: "30",
  untilDay: "2026-11-04",
  cost: { nanos: 12_340_000_000, unpriced: false, priced: true },
  tokens: 1_234_567,
  topModel: "claude-opus-4-5",
  sessions: 12,
  days: Array.from({ length: 14 }, (_, i): [string, ReturnType<typeof tk>] => [localDay(new Date(2026, 9, 22 + i)), tk((i + 1) * 100)]),
};

const colors: Record<ShareColor, string> = {
  "--x-color-bg": "tok-bg",
  "--x-color-surface": "tok-surface",
  "--x-color-line": "tok-line",
  "--x-color-ink": "tok-ink",
  "--x-color-muted": "tok-muted",
  "--x-color-accent": "tok-accent",
};

describe("shareText", () => {
  it("says provider, range, tokens, sessions and cost in English", () => {
    const text = shareText(data, tr("en"), "en");
    expect(text).toContain("Claude");
    expect(text).toContain("last 30 days");
    expect(text).toContain("1,234,567 tokens");
    expect(text).toContain("12 sessions");
    expect(text).toContain("$12.34");
  });

  it("is Vietnamese in vi", () => {
    const text = shareText(data, tr("vi"), "vi");
    expect(text).toContain("30 ngày qua");
    expect(text).toContain("12 phiên");
    expect(text).toContain("$12.34");
  });

  it("says Through {date} for All time", () => {
    const text = shareText({ ...data, range: "all" }, tr("en"), "en");
    expect(text).toMatch(/through Nov 4, 2026/);
  });

  it("leaves the cost out when nothing was priced, and uses the singular for one session", () => {
    const text = shareText({ ...data, cost: { nanos: 0, unpriced: true, priced: false }, sessions: 1 }, tr("en"), "en");
    expect(text).not.toContain("$");
    expect(text).not.toContain("n/a");
    expect(text).toContain("1 session");
    expect(text).not.toContain("1 sessions");
  });
});

describe("shareCardSvg", () => {
  const svg = shareCardSvg(data, colors, tr("en"), "en");

  it("is a 480 by 270 card with the figures on it", () => {
    expect(svg).toContain('viewBox="0 0 480 270"');
    for (const part of ["Claude usage", "1,234,567", "$12.34", ">12<", "claude-opus-4-5", "last 30 days"]) expect(svg).toContain(part);
  });

  it("draws one bar for each of the last ten days", () => {
    expect(svg.match(/<rect [^>]*rx="2"/g)).toHaveLength(10);
  });

  it("is painted only with the colours it was given", () => {
    const used = [...svg.matchAll(/(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]);
    const allowed = new Set(Object.values(colors));
    expect(used.length).toBeGreaterThan(0);
    for (const c of used) expect(allowed.has(c!), c).toBe(true);
    expect(SHARE_COLORS).toHaveLength(6);
  });

  it("escapes markup in a model name", () => {
    const evil = shareCardSvg({ ...data, topModel: 'a<b>&"c' }, colors, tr("en"), "en");
    expect(evil).toContain("a&lt;b&gt;&amp;&quot;c");
    expect(evil).not.toContain("a<b>");
  });

  it("notes unpriced models only when some cost is shown", () => {
    const partial = shareCardSvg({ ...data, cost: { nanos: 5, unpriced: true, priced: true } }, colors, tr("en"), "en");
    expect(partial).toContain("excludes unpriced models");
    expect(svg).not.toContain("excludes unpriced models");
    const none = shareCardSvg({ ...data, cost: { nanos: 0, unpriced: true, priced: false } }, colors, tr("en"), "en");
    expect(none).toContain("n/a");
    expect(none).not.toContain("excludes unpriced models");
  });

  it("has no model line without a model", () => {
    expect(shareCardSvg({ ...data, topModel: null }, colors, tr("en"), "en")).not.toContain("Top model");
  });
});
