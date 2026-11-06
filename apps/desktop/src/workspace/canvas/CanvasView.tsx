import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { percentOf, wheelFactor, zoomKey, ZoomBar } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import type { PaneLayout, PaneNode } from "../paneTree";
import { canvasReduce, NUDGE_STEP, PAN_STEP, screenRect, ZOOM_STEP, type CanvasAction, type CanvasState } from "./canvasModel";

type Leaf = Extract<PaneNode, { kind: "leaf" }>;

/** A press that moves less than this is a click, not a drag. */
const DRAG_PX = 3;

/** Where a terminal sits over the body of its card, under the card's header. */
export function cardBodyStyle(r: { x: number; y: number; w: number; h: number }, z: number) {
  return {
    left: `${r.x}px`,
    top: `calc(${r.y}px + var(--ws-strip-h))`,
    width: `${r.w}px`,
    height: `calc(${r.h}px - var(--ws-strip-h))`,
    zIndex: z,
  };
}

/** Stacking order of the cards: the focused one on top, the rest by order. */
export function cardLayers(ids: string[], focused: string): Record<string, number> {
  const out: Record<string, number> = {};
  ids.forEach((id, i) => (out[id] = id === focused ? ids.length + 1 : i + 1));
  return out;
}

function flat(n: PaneNode, out: Leaf[] = []): Leaf[] {
  if (n.kind === "leaf") out.push(n);
  else for (const c of n.children) flat(c, out);
  return out;
}

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as const;

interface Drag {
  pane: string;
  pointerId: number;
  from: { x: number; y: number };
  moved: boolean;
}

/**
 * The panes as cards on a pannable, zoomable surface. Terminals are not children: they sit in a flat list
 * beside this and are placed over the card bodies from the same numbers (`screenRect`, `cardBodyStyle`).
 * Dragging a card moves only a CSS transform (the card and its terminals), and the position is committed
 * once on release, so a terminal never changes size mid-drag and is refitted once, when the drag ends.
 */
export function CanvasView(props: {
  layout: PaneLayout & { canvas: CanvasState };
  strip: (leaf: Leaf) => ReactNode;
  onFocus: (pane: string) => void;
  onChange: (next: CanvasState) => void;
}): JSX.Element {
  const { layout, strip, onFocus } = props;
  const canvas = layout.canvas;
  const { t } = useI18n();
  const surface = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pan, setPan] = useState<{ pointerId: number; x: number; y: number } | null>(null);
  const [said, setSaid] = useState("");
  // The wheel listener is bound once (it must be non-passive); it reads the latest state here.
  const latest = useRef({ canvas, onChange: props.onChange });
  latest.current = { canvas, onChange: props.onChange };

  const viewport = () => {
    const r = surface.current?.getBoundingClientRect();
    return { w: r?.width ?? 0, h: r?.height ?? 0 };
  };
  const send = (a: CanvasAction) => {
    const { canvas: c, onChange } = latest.current;
    const next = canvasReduce(c, a);
    if (next !== c) onChange(next);
  };
  const centre = () => {
    const v = viewport();
    return { x: v.w / 2, y: v.h / 2 };
  };
  const zoomBy = (factor: number) => send({ type: "zoom", factor, at: centre() });

  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = node.getBoundingClientRect();
        send({ type: "zoom", factor: wheelFactor(e.deltaY), at: { x: e.clientX - r.left, y: e.clientY - r.top } });
      } else send({ type: "pan", dx: -e.deltaX, dy: -e.deltaY });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const cards = flat(layout.root);

  // The terminals of a card follow its header while it is dragged: a transform, so nothing is resized.
  const shift = (pane: string, dx: number, dy: number) => {
    const root = surface.current?.parentElement;
    const leaf = cards.find((n) => n.id === pane);
    if (!root || !leaf) return;
    const value = dx === 0 && dy === 0 ? "" : `translate(${dx}px, ${dy}px)`;
    root.querySelector<HTMLElement>(`[data-card="${pane}"]`)?.style.setProperty("transform", value);
    for (const id of leaf.tabs) {
      root.querySelectorAll<HTMLElement>(`.ws-tab-pane[data-tab="${CSS.escape(id)}"]`).forEach((el) => (el.style.transform = value));
    }
  };

  // Screen px of a move, as world units.
  const nudge = (pane: string, dx: number, dy: number) => send({ type: "move", id: pane, dx: dx / canvas.zoom, dy: dy / canvas.zoom });

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key in ARROWS) {
      e.preventDefault();
      const [x, y] = ARROWS[e.key as keyof typeof ARROWS];
      // An arrow moves the view the way the content goes: right pans toward the cards on the left.
      return send({ type: "pan", dx: -x * PAN_STEP, dy: -y * PAN_STEP });
    }
    const key = zoomKey(e.key);
    if (!key) return;
    e.preventDefault();
    if (key === "reset") send({ type: "reset" });
    else zoomBy(key === "in" ? ZOOM_STEP : 1 / ZOOM_STEP);
  };

  // Empty space pans the view.
  const onSurfaceDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setPan({ pointerId: e.pointerId, x: e.clientX, y: e.clientY });
  };
  const onSurfaceMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pan || e.pointerId !== pan.pointerId) return;
    send({ type: "pan", dx: e.clientX - pan.x, dy: e.clientY - pan.y });
    setPan({ ...pan, x: e.clientX, y: e.clientY });
  };

  const layers = cardLayers(
    cards.map((n) => n.id),
    layout.focused,
  );

  return (
    <div
      ref={surface}
      className="cv-surface"
      data-panning={pan ? "true" : undefined}
      data-dragging={drag?.moved ? "true" : undefined}
      role="group"
      aria-label={t("canvas.label")}
      aria-describedby="cv-help"
      tabIndex={0}
      onKeyDown={onKey}
      onPointerDown={onSurfaceDown}
      onPointerMove={onSurfaceMove}
      onPointerUp={() => setPan(null)}
      onPointerCancel={() => setPan(null)}
    >
      <p id="cv-help" className="cv-sr">
        {t("canvas.help")}
      </p>
      {cards.map((n) => {
        const r = screenRect(canvas, canvas.cards[n.id] ?? { x: 0, y: 0, w: 0, h: 0 });
        return (
          <div
            key={n.id}
            className="ws-pane cv-card"
            data-pane={n.id}
            data-card={n.id}
            data-focused={n.id === layout.focused}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: layers[n.id] }}
            onPointerDown={() => onFocus(n.id)}
          >
            <div
              className="ws-pane-head cv-head"
              onPointerDown={(e) => {
                // Buttons, tabs and fields in the strip keep their own behaviour; the rest of the header moves the card.
                const target = e.target as HTMLElement;
                const own = !target.closest(".cv-grip") && target.closest("button, a, input, textarea, select, [role=tab], [draggable=true]");
                if (e.button !== 0 || own) return;
                e.currentTarget.setPointerCapture?.(e.pointerId);
                setDrag({ pane: n.id, pointerId: e.pointerId, from: { x: e.clientX, y: e.clientY }, moved: false });
              }}
              onPointerMove={(e) => {
                if (!drag || drag.pane !== n.id || e.pointerId !== drag.pointerId) return;
                const dx = e.clientX - drag.from.x;
                const dy = e.clientY - drag.from.y;
                if (!drag.moved && Math.hypot(dx, dy) < DRAG_PX) return;
                if (!drag.moved) setDrag({ ...drag, moved: true });
                shift(n.id, dx, dy);
              }}
              onPointerUp={(e) => {
                if (!drag || drag.pane !== n.id || e.pointerId !== drag.pointerId) return;
                const dx = e.clientX - drag.from.x;
                const dy = e.clientY - drag.from.y;
                shift(n.id, 0, 0);
                setDrag(null);
                if (drag.moved) nudge(n.id, dx, dy);
              }}
              onPointerCancel={() => {
                shift(n.id, 0, 0);
                setDrag(null);
              }}
            >
              <div
                className="cv-grip"
                role="button"
                tabIndex={0}
                aria-label={t("canvas.move")}
                title={t("canvas.move")}
                onKeyDown={(e) => {
                  if (!(e.key in ARROWS)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const [x, y] = ARROWS[e.key as keyof typeof ARROWS];
                  nudge(n.id, x * NUDGE_STEP, y * NUDGE_STEP);
                  setSaid(t("canvas.moved"));
                }}
              />
              {strip(n)}
            </div>
          </div>
        );
      })}
      <div className="cv-bar" onPointerDown={(e) => e.stopPropagation()}>
        <ZoomBar
          zoom={percentOf(canvas.zoom, 1)}
          onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
          onZoomIn={() => zoomBy(ZOOM_STEP)}
          onFit={() => send({ type: "fit", viewport: viewport() })}
          onActual={() => send({ type: "reset" })}
          labels={{ zoomOut: t("canvas.zoomOut"), zoomIn: t("canvas.zoomIn"), fit: t("canvas.fit"), actual: t("canvas.reset"), group: t("canvas.zoom") }}
        />
      </div>
      <span className="cv-sr" role="status">
        {said}
      </span>
    </div>
  );
}
