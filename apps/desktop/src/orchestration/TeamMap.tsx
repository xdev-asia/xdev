import { useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { TabLink } from "@/api";
import { useI18n } from "@/i18n";
import { NODE_H, NODE_W, grantWords, layoutTeam, neighbour } from "./teamLayout";

export interface TeamMapProps {
  tabs: { id: string; label: string }[];
  links: TabLink[];
  /** Focuses the tab in the workspace. */
  onFocusTab(id: string): void;
}

const LABEL_CHARS = 18;

function cut(label: string): string {
  return label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label;
}

/** Tabs as nodes and links as arrows labelled with their grants. Arrow keys move between nodes, Enter focuses the tab. */
export function TeamMap({ tabs, links, onFocusTab }: TeamMapProps): JSX.Element {
  const { t } = useI18n();
  const layout = useMemo(() => layoutTeam(tabs, links), [tabs, links]);
  const [active, setActive] = useState<string | null>(null);
  const refs = useRef(new Map<string, SVGGElement>());
  const current = layout.nodes.some((n) => n.id === active) ? active : layout.nodes[0]?.id ?? null;
  const label = (id: string) => tabs.find((x) => x.id === id)?.label ?? id;
  const grants = (l: Pick<TabLink, "transcript" | "screen">) => {
    const words = grantWords(l).map((w) => t(`mission.grant.${w}`));
    return words.length ? words.join(", ") : t("mission.map.noGrants");
  };

  function onKey(e: KeyboardEvent<SVGGElement>, id: string): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onFocusTab(id);
      return;
    }
    const next = neighbour(layout, id, e.key);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    refs.current.get(next)?.focus();
  }

  if (layout.nodes.length === 0) return <p className="mc-empty">{t("mission.map.empty")}</p>;
  return (
    <div className="mc-map">
      <p className="mc-hint" id="mc-map-hint">
        {t("mission.map.hint")}
      </p>
      <div className="mc-map-scroll">
        <svg
          className="mc-map-svg"
          role="group"
          aria-label={t("mission.map.label")}
          aria-describedby="mc-map-hint"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
        >
          <defs>
            <marker id="mc-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="mc-arrow" />
            </marker>
          </defs>
          {layout.edges.map((e) => (
            <g key={`${e.from}>${e.to}`} className="mc-edge" data-testid={`edge-${e.from}-${e.to}`} aria-hidden="true">
              <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} markerEnd="url(#mc-arrow)" />
              <text x={(e.x1 + e.x2) / 2} y={(e.y1 + e.y2) / 2 - 6} textAnchor="middle" className="mc-edge-label">
                {grants(e)}
              </text>
            </g>
          ))}
          {layout.nodes.map((n) => (
            <g
              key={n.id}
              ref={(el) => {
                if (el) refs.current.set(n.id, el);
                else refs.current.delete(n.id);
              }}
              className="mc-node"
              role="button"
              tabIndex={n.id === current ? 0 : -1}
              aria-label={t("mission.map.node", { name: n.label })}
              transform={`translate(${n.x} ${n.y})`}
              onClick={() => onFocusTab(n.id)}
              onFocus={() => setActive(n.id)}
              onKeyDown={(e) => onKey(e, n.id)}
            >
              <rect width={NODE_W} height={NODE_H} rx={8} />
              <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle">
                {cut(n.label)}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <ul className="x-sr-only" aria-label={t("mission.map.list")}>
        {layout.edges.length === 0 ? <li>{t("mission.map.noLinks")}</li> : null}
        {layout.edges.map((e) => (
          <li key={`${e.from}>${e.to}`}>{t("mission.map.edge", { from: label(e.from), to: label(e.to), grants: grants(e) })}</li>
        ))}
      </ul>
    </div>
  );
}
