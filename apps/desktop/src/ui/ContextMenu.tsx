import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/i18n";
import { attachDismiss, clampToWindow, initialMenu, menuKey, type MenuState } from "./menuModel";

/** One row of a context menu. A `separator` row has only an id. */
export interface MenuItem {
  id: string;
  labelKey: string;
  /** Shown right aligned and muted, when the shortcut store gives one. */
  chord?: string;
  disabled?: boolean;
  danger?: boolean;
  run?: () => void;
  children?: MenuItem[];
  kind?: "separator";
  /** A colour token name (`--x-tab-color-3`) drawn as a swatch before the label. */
  swatch?: string;
  /** Set on a choice among several: marks the current one (`menuitemradio`). */
  checked?: boolean;
}

type T = (key: string) => string;

/** One level of the menu: plain markup, no hooks, so it renders on the server for tests. */
export function MenuPanel(p: {
  items: MenuItem[];
  /** The open path; this level's own prefix is `prefix`. */
  path: number[];
  prefix?: number[];
  t: T;
  onHover?(path: number[]): void;
  onPick?(item: MenuItem, path: number[]): void;
  /** A line above the top level's rows: not focusable, not an item. */
  title?: string;
}): JSX.Element {
  const prefix = p.prefix ?? [];
  return (
    <>
      {p.title !== undefined && prefix.length === 0 && (
        <div className="x-menu-group term-link-dest" role="presentation" title={p.title}>
          {p.title}
        </div>
      )}
      {p.items.map((item, i) => {
        if (item.kind === "separator") return <div key={item.id} role="separator" className="x-menu-sep" />;
        const at = [...prefix, i];
        const key = at.join(".");
        const active = p.path.length === at.length && p.path.every((n, j) => n === at[j]);
        const open = !!item.children && p.path.length > at.length && at.every((n, j) => n === p.path[j]);
        const role = item.checked === undefined ? "menuitem" : "menuitemradio";
        return (
          <div key={item.id} className="x-menu-row">
            <button
              type="button"
              role={role}
              tabIndex={-1}
              className="x-menu-item"
              data-path={key}
              data-active={active || undefined}
              data-danger={item.danger || undefined}
              aria-disabled={item.disabled || undefined}
              aria-checked={item.checked}
              aria-haspopup={item.children ? "menu" : undefined}
              aria-expanded={item.children ? open : undefined}
              onMouseEnter={() => !item.disabled && p.onHover?.(at)}
              onClick={() => !item.disabled && p.onPick?.(item, at)}
            >
              {item.swatch && <span className="x-menu-swatch" aria-hidden="true" style={{ background: `var(${item.swatch})` }} />}
              <span className="x-menu-label">{p.t(item.labelKey)}</span>
              {item.chord && <span className="x-menu-chord">{item.chord}</span>}
              {item.children && (
                <span className="x-menu-arrow" aria-hidden="true">
                  ›
                </span>
              )}
            </button>
            {open && item.children && (
              <div role="menu" className="x-menu x-menu-sub">
                <MenuPanel {...p} title={undefined} items={item.children} prefix={at} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * A menu at a point, in a portal, clamped to the window. Closes on outside click, Escape, blur and
 * scroll; arrows, Home / End, Enter, type-ahead, Left / Right for submenus. Focus goes back to the
 * element that had it when the menu opened, unless an item moved it somewhere else (a dialog).
 */
export function ContextMenu(p: { at: { x: number; y: number }; items: MenuItem[]; title?: string; label?: string; onClose(): void }): JSX.Element | null {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<MenuState>(() => initialMenu(p.items));
  const [pos, setPos] = useState(p.at);
  const [flip, setFlip] = useState(false);
  const close = useRef(p.onClose);
  close.current = p.onClose;

  // Measured once drawn: keep the menu inside the window, and open submenus to the left near the right edge.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const win = { w: window.innerWidth, h: window.innerHeight };
    const next = clampToWindow(p.at, { w: box.width, h: box.height }, win);
    setPos(next);
    setFlip(next.x + box.width + box.width > win.w);
  }, [p.at.x, p.at.y]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const off = attachDismiss(window, document, (n) => !!root.current?.contains(n as Node), () => close.current());
    return () => {
      off();
      const now = document.activeElement;
      // Nobody else took focus: give it back to where the menu came from.
      if ((!now || now === document.body || root.current?.contains(now)) && opener?.isConnected) opener.focus();
    };
  }, []);

  // The active item holds the focus, so screen readers follow the arrows.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>(`[data-path="${state.path.join(".")}"]`)?.focus();
  }, [state.path.join(".")]);

  const pick = (item: MenuItem, path: number[]) => {
    if (item.children?.length) return setState({ path: [...path, 0] });
    item.run?.();
    close.current();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") return close.current();
    const out = menuKey(state, e.key, p.items, t);
    if (e.key.length > 1 || e.key === " " || out.state !== state || out.effect) e.preventDefault();
    setState(out.state);
    if (out.effect?.kind === "close") close.current();
    if (out.effect?.kind === "run") {
      out.effect.item.run?.();
      close.current();
    }
  };

  return createPortal(
    <div
      ref={root}
      role="menu"
      aria-label={p.label}
      className="x-menu x-menu-root"
      data-flip={flip || undefined}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuPanel items={p.items} title={p.title} path={state.path} t={t} onHover={(path) => setState({ path })} onPick={pick} />
    </div>,
    document.body,
  );
}
