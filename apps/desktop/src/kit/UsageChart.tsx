import type { JSX } from "react";
import type { UsageSummary } from "@/api";
import { useI18n } from "@/i18n";
import { totalOf } from "./kitUi";

const WIDTH = 640;
const HEIGHT = 200;
const TOP = 14;
const BOTTOM = 22;
const SIDE = 4;
const PARTS = ["input", "output", "cache"] as const;

/** A short count for an axis: 1.2k, 3.4M. */
export function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** One stacked bar per day: input at the bottom, then output, then cache (read and written). */
export function UsageChart(props: { days: UsageSummary["days"] }): JSX.Element {
  const { t } = useI18n();
  const { days } = props;
  const max = Math.max(1, ...days.map(([, tokens]) => totalOf(tokens)));
  const plot = HEIGHT - TOP - BOTTOM;
  const slot = (WIDTH - SIDE * 2) / Math.max(1, days.length);
  const width = slot * 0.64;
  // Label about seven days, however many there are.
  const every = Math.max(1, Math.ceil(days.length / 7));
  return (
    <svg
      className="kit-chart"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={t("kit.usage.chart")}
      preserveAspectRatio="xMidYMid meet"
    >
      <line className="kit-chart-axis" x1={SIDE} x2={WIDTH - SIDE} y1={HEIGHT - BOTTOM} y2={HEIGHT - BOTTOM} />
      <text className="kit-chart-label" x={SIDE} y={TOP - 3}>
        {short(max)}
      </text>
      {days.map(([day, tokens], i) => {
        const values = { input: tokens.input, output: tokens.output, cache: tokens.cache_read + tokens.cache_write };
        const x = SIDE + i * slot + (slot - width) / 2;
        let floor = HEIGHT - BOTTOM;
        return (
          <g key={day} data-day={day}>
            <title>{t("kit.usage.dayTitle", { day, total: totalOf(tokens) })}</title>
            {PARTS.map((part) => {
              const h = (values[part] / max) * plot;
              floor -= h;
              return <rect key={part} className={`kit-bar kit-bar-${part}`} data-part={part} x={x} y={floor} width={width} height={h} />;
            })}
            {i % every === 0 && (
              <text className="kit-chart-label" x={x + width / 2} y={HEIGHT - 6} textAnchor="middle">
                {day.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
