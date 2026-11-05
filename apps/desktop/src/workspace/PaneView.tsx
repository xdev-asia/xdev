import { useState } from "react";
import type { CSSProperties, JSX, PointerEvent, ReactNode } from "react";
import { useI18n } from "@/i18n";
import type { PaneLayout, PaneNode } from "./paneTree";
import type { DropZone } from "./sessions";

export const DROP_ZONES: readonly DropZone[] = ["left", "right", "top", "bottom"];

type Leaf = Extract<PaneNode, { kind: "leaf" }>;

/** Where a pane sits inside the pane area, as fractions of it. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN = 0.1;

/**
 * The rectangle of every visible leaf. Terminals are placed from these by CSS, so they stay in one flat
 * list (and mounted) while panes come and go. While a pane is expanded it is the only one with a rect.
 */
export function paneRects(layout: PaneLayout): Record<string, Rect> {
  const out: Record<string, Rect> = {};
  const walk = (n: PaneNode, r: Rect): void => {
    if (n.kind === "leaf") {
      out[n.id] = r;
      return;
    }
    let at = 0;
    n.children.forEach((c, i) => {
      const s = n.sizes[i];
      walk(c, n.dir === "right" ? { x: r.x + at * r.w, y: r.y, w: s * r.w, h: r.h } : { x: r.x, y: r.y + at * r.h, w: r.w, h: s * r.h });
      at += s;
    });
  };
  walk(layout.root, { x: 0, y: 0, w: 1, h: 1 });
  if (layout.expanded && out[layout.expanded]) return { [layout.expanded]: { x: 0, y: 0, w: 1, h: 1 } };
  return out;
}

/** The style that puts a terminal over its pane's body, under the pane's tab strip. */
export function bodyStyle(r: Rect): CSSProperties {
  const pct = (n: number) => `${+(n * 100).toFixed(4)}%`;
  return {
    left: pct(r.x),
    top: `calc(${pct(r.y)} + var(--ws-strip-h))`,
    width: pct(r.w),
    height: `calc(${pct(r.h)} - var(--ws-strip-h))`,
  };
}

/** Moves the border after child `i` by `delta` (a fraction of the split); both neighbours keep at least 0.1. */
export function dragSizes(sizes: number[], i: number, delta: number): number[] {
  if (i < 0 || i + 1 >= sizes.length) return sizes;
  const pair = sizes[i] + sizes[i + 1];
  const left = Math.min(Math.max(sizes[i] + delta, Math.min(MIN, pair / 2)), pair - Math.min(MIN, pair / 2));
  const next = sizes.slice();
  next[i] = left;
  next[i + 1] = pair - left;
  return next;
}

interface Drag {
  split: string;
  index: number;
  from: number;
  extent: number;
  sizes: number[];
}

/**
 * The chrome of a pane tree: split containers, drag handles and one tab strip per pane. Pane bodies are
 * left empty; the terminals sit in a flat list beside this and are placed by `paneRects`.
 */
export function PaneView(props: {
  layout: PaneLayout;
  /** The tab strip of one pane. */
  strip: (leaf: Leaf) => ReactNode;
  onFocus: (pane: string) => void;
  onResize: (split: string, sizes: number[]) => void;
  onEqualize: () => void;
  /** The tab drag in progress; while set, every pane shows edge drop zones and the one under the pointer is lit. */
  tabDrag?: { id: string; over: { pane: string; zone: DropZone } | null } | null;
}): JSX.Element {
  const { layout, strip, onFocus, onResize, onEqualize, tabDrag } = props;
  const { t } = useI18n();
  const [drag, setDrag] = useState<Drag | null>(null);

  const leaf = (n: Leaf, basis: number | null): JSX.Element => (
    <div
      key={n.id}
      className="ws-pane"
      data-pane={n.id}
      data-focused={n.id === layout.focused}
      style={basis === null ? undefined : { flexBasis: `${basis * 100}%` }}
      onPointerDown={() => onFocus(n.id)}
    >
      {strip(n)}
      {tabDrag && (
        <div className="ws-dropzones" data-dropzones={n.id} aria-hidden="true">
          {DROP_ZONES.map((zone) => (
            <div key={zone} className="ws-dropzone" data-zone={zone} data-over={(tabDrag.over?.pane === n.id && tabDrag.over.zone === zone) || undefined} />
          ))}
        </div>
      )}
    </div>
  );

  const node = (n: PaneNode, basis: number | null): JSX.Element => {
    if (n.kind === "leaf") return leaf(n, basis);
    const horizontal = n.dir === "right";
    let at = 0;
    return (
      <div key={n.id} className="ws-split" data-split-id={n.id} data-dir={n.dir} style={basis === null ? undefined : { flexBasis: `${basis * 100}%` }}>
        {n.children.map((c, i) => node(c, n.sizes[i]))}
        {n.sizes.slice(0, -1).map((s, i) => {
          at += s;
          const place = { [horizontal ? "left" : "top"]: `${at * 100}%` };
          return (
            <div
              key={`h${i}`}
              className="ws-handle"
              role="separator"
              aria-orientation={horizontal ? "vertical" : "horizontal"}
              aria-label={t("panes.resize")}
              style={place}
              onDoubleClick={onEqualize}
              onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
                const box = e.currentTarget.parentElement?.getBoundingClientRect();
                const extent = box ? (horizontal ? box.width : box.height) : 0;
                if (!extent) return;
                e.currentTarget.setPointerCapture?.(e.pointerId);
                setDrag({ split: n.id, index: i, from: horizontal ? e.clientX : e.clientY, extent, sizes: n.sizes.slice() });
              }}
              onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
                if (!drag || drag.split !== n.id || drag.index !== i) return;
                const now = horizontal ? e.clientX : e.clientY;
                onResize(n.id, dragSizes(drag.sizes, i, (now - drag.from) / drag.extent));
              }}
              onPointerUp={() => setDrag(null)}
              onPointerCancel={() => setDrag(null)}
            />
          );
        })}
      </div>
    );
  };

  // An expanded pane is the only one drawn.
  const expanded = layout.expanded ? findLeaf(layout.root, layout.expanded) : null;
  return (
    <div className="ws-pane-tree" data-expanded={expanded ? "true" : undefined}>
      {expanded ? leaf(expanded, null) : node(layout.root, null)}
    </div>
  );
}

function findLeaf(n: PaneNode, id: string): Leaf | null {
  if (n.kind === "leaf") return n.id === id ? n : null;
  for (const c of n.children) {
    const f = findLeaf(c, id);
    if (f) return f;
  }
  return null;
}
