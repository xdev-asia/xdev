import type { Agent, Cost } from "@/api";
import { formatCount, type Tokens } from "./kitUi";
import type { UsageRange } from "./usageRange";
import { formatCost, recentDays } from "./usageStats";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export type ShareCardData = {
  provider: Agent;
  range: UsageRange;
  /** Local `YYYY-MM-DD` the range ends on. */
  untilDay: string;
  cost: Cost;
  tokens: number;
  topModel: string | null;
  sessions: number;
  days: [string, Tokens][];
};

/** Theme custom properties the card is painted with; the app source holds no colour literal. */
export const SHARE_COLORS = ["--x-color-bg", "--x-color-surface", "--x-color-line", "--x-color-ink", "--x-color-muted", "--x-color-accent"] as const;
export type ShareColor = (typeof SHARE_COLORS)[number];

export const CARD_WIDTH = 480;
export const CARD_HEIGHT = 270;
const BAR_DAYS = 10;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

function rangeLabel(d: ShareCardData, t: Translate, locale: string): string {
  if (d.range !== "all") return t(`usage.share.range.${d.range}`);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parseDay(d.untilDay));
  return t("usage.share.range.all", { date });
}

/** The post text: provider, range, tokens, sessions and, when something was priced, the estimated cost. */
export function shareText(d: ShareCardData, t: Translate, locale: string): string {
  const vars = {
    provider: t(`usage.stats.provider.${d.provider}`),
    range: rangeLabel(d, t, locale),
    tokens: formatCount(d.tokens, locale),
    count: d.sessions,
    cost: formatCost(d.cost),
  };
  return t(d.cost.priced ? "usage.share.text" : "usage.share.textNoCost", vars);
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A 480×270 card for the clipboard: title, three figures, the top model and the last ten days as bars. */
export function shareCardSvg(d: ShareCardData, colors: Record<ShareColor, string>, t: Translate, locale: string): string {
  const bg = colors["--x-color-bg"];
  const surface = colors["--x-color-surface"];
  const line = colors["--x-color-line"];
  const ink = colors["--x-color-ink"];
  const muted = colors["--x-color-muted"];
  const accent = colors["--x-color-accent"];

  const text = (x: number, y: number, size: number, weight: number, fill: string, body: string, anchor = "start") =>
    `<text x="${x}" y="${y}" font-family="${esc(FONT)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(body)}</text>`;

  const figures: [string, string][] = [
    [t("usage.share.card.tokens"), formatCount(d.tokens, locale)],
    [t("usage.share.card.cost"), formatCost(d.cost)],
    [t("usage.share.card.sessions"), formatCount(d.sessions, locale)],
  ];
  const parts = figures.map(([label, value], i) => {
    const x = 32 + i * 148;
    return text(x, 104, 12, 400, muted, label) + text(x, 132, 24, 700, ink, value);
  });

  const bars = recentDays(d.days, BAR_DAYS, parseDay(d.untilDay));
  const peak = Math.max(1, ...bars.map((b) => b.total));
  const baseline = 242;
  const maxHeight = 64;
  const slot = (CARD_WIDTH - 64) / BAR_DAYS;
  const rects = bars.map((b, i) => {
    const h = b.total === 0 ? 2 : Math.max(2, Math.round((b.total / peak) * maxHeight));
    const fill = b.total === 0 ? line : accent;
    return `<rect x="${(32 + i * slot + 3).toFixed(1)}" y="${baseline - h}" width="${(slot - 6).toFixed(1)}" height="${h}" rx="2" fill="${fill}"/>`;
  });

  const footer = [
    d.topModel === null ? "" : `${t("usage.share.card.topModel")}: ${d.topModel}`,
    d.cost.priced && d.cost.unpriced ? t("usage.share.card.excludes") : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="16" fill="${bg}"/>`,
    `<rect x="1" y="1" width="${CARD_WIDTH - 2}" height="${CARD_HEIGHT - 2}" rx="15" fill="${surface}" stroke="${line}"/>`,
    text(32, 46, 16, 700, ink, t("usage.share.card.title", { provider: t(`usage.stats.provider.${d.provider}`) })),
    text(32, 66, 12, 400, muted, rangeLabel(d, t, locale)),
    text(CARD_WIDTH - 32, 46, 14, 700, accent, t("usage.share.card.brand"), "end"),
    ...parts,
    footer === "" ? "" : text(32, 162, 12, 400, muted, footer),
    ...rects,
    `<line x1="32" y1="${baseline + 0.5}" x2="${CARD_WIDTH - 32}" y2="${baseline + 0.5}" stroke="${line}"/>`,
    "</svg>",
  ]
    .filter(Boolean)
    .join("");
}
