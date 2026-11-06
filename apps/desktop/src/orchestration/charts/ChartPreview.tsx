import type { JSX } from "react";
import type { Chart } from "@/api";
import { useI18n } from "@/i18n";
import { NODE_H, NODE_W, grantWords } from "../teamLayout";
import { previewLayout, seatLabel } from "./chartModel";

const LABEL_CHARS = 18;

function cut(label: string): string {
  return label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label;
}

/** The chart as the team map would draw it, read-only. The picture is described by the list under it. */
export function ChartPreview({ chart }: { chart: Pick<Chart, "seats" | "edges"> }): JSX.Element {
  const { t } = useI18n();
  const label = (seat: Chart["seats"][number], i: number) => seatLabel(seat, i, t);
  const layout = previewLayout(chart, label);
  const name = (id: string) => layout.nodes.find((n) => n.id === id)?.label ?? id;
  const grants = (e: Pick<Chart["edges"][number], "transcript" | "screen">) => {
    const words = grantWords(e).map((w) => t(`mission.grant.${w}`));
    return words.length ? words.join(", ") : t("mission.map.noGrants");
  };
  if (layout.nodes.length === 0) return <p className="charts-muted">{t("charts.preview.empty")}</p>;
  return (
    <figure className="charts-preview" aria-labelledby="charts-preview-title">
      <figcaption id="charts-preview-title" className="charts-label">
        {t("charts.preview.title")}
      </figcaption>
      <div className="mc-map-scroll">
        <svg className="mc-map-svg" aria-hidden="true" data-testid="chart-preview" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height}>
          <defs>
            <marker id="charts-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="mc-arrow" />
            </marker>
          </defs>
          {layout.edges.map((e) => (
            <g key={`${e.from}>${e.to}`} className="mc-edge">
              <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} markerEnd="url(#charts-arrow)" />
            </g>
          ))}
          {layout.nodes.map((n) => (
            <g key={n.id} className="charts-node" data-seat={n.id} transform={`translate(${n.x} ${n.y})`}>
              <rect width={NODE_W} height={NODE_H} rx={8} />
              <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle">
                {cut(n.label)}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <ul className="x-sr-only" aria-label={t("charts.preview.list")}>
        {layout.edges.length === 0 ? <li>{t("charts.preview.noEdges")}</li> : null}
        {layout.edges.map((e) => (
          <li key={`${e.from}>${e.to}`}>{t("mission.map.edge", { from: name(e.from), to: name(e.to), grants: grants(e) })}</li>
        ))}
      </ul>
    </figure>
  );
}
