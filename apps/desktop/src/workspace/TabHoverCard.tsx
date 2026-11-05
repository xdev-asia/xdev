import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";

export interface TabCardData {
  title: string;
  agent: string;
  status: string;
  cwd: string;
}

/** The card text: title, agent, status and working directory of a tab. `t` translates the row labels. */
export function TabHoverCard(props: { id: string; data: TabCardData; at: { x: number; y: number }; labels: { agent: string; status: string; cwd: string } }): JSX.Element {
  const { id, data, at, labels } = props;
  const width = typeof window === "undefined" ? 320 : window.innerWidth;
  const left = Math.max(8, Math.min(at.x, width - 8 - Math.min(320, width - 16)));
  return (
    <div className="x-tooltip ws-tab-card" role="tooltip" id={id} data-placement="bottom" data-open="" style={{ left, top: at.y }}>
      <strong className="ws-tab-card-title">{data.title}</strong>
      <dl className="ws-tab-card-rows">
        <dt>{labels.agent}</dt>
        <dd>{data.agent}</dd>
        <dt>{labels.status}</dt>
        <dd>{data.status}</dd>
        <dt>{labels.cwd}</dt>
        <dd className="ws-mono">{data.cwd}</dd>
      </dl>
    </div>
  );
}

export const HOVER_DELAY_MS = 600;

/**
 * Which tab shows its card and where. Hover waits `HOVER_DELAY_MS`; keyboard focus shows it at once;
 * leaving, blurring or Escape hides it.
 */
export function useTabHover(): {
  open: { id: string; x: number; y: number } | null;
  show: (id: string, el: Element, delay: number) => void;
  hide: () => void;
} {
  const [open, setOpen] = useState<{ id: string; x: number; y: number } | null>(null);
  const [timer] = useState<{ current: ReturnType<typeof setTimeout> | null }>(() => ({ current: null }));
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(null);
  }, []);
  const show = useCallback((id: string, el: Element, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    const run = () => {
      const r = el.getBoundingClientRect();
      setOpen({ id, x: r.left, y: r.bottom + 4 });
    };
    if (delay <= 0) run();
    else timer.current = setTimeout(run, delay);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, hide]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return { open, show, hide };
}

/** Renders a card at the document body so the scrolling tab list does not clip it. */
export function CardPortal({ children }: { children: JSX.Element }): JSX.Element | null {
  return typeof document === "undefined" ? null : createPortal(children, document.body);
}
