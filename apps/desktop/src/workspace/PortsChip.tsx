import { useEffect, useRef } from "react";
import type { JSX, KeyboardEvent } from "react";
import { Icon } from "@xdev-asia/ui";
import type { LivePort } from "./livePorts";
import { useI18n } from "@/i18n";

/** What the chip shows and copies: the connect host as the Ports panel has it. */
export function endpoint(port: LivePort): string {
  return port.endpoint;
}

/** The plug and the count on a card; nothing at zero. A span with a button role: it sits inside the row's own button. */
export function PortsChip(props: { count: number; onOpen(at: { x: number; y: number }): void }): JSX.Element | null {
  const { t } = useI18n();
  if (props.count === 0) return null;
  const label = t("ports.count", { count: props.count });
  return (
    <span
      className="ws-pr ws-ports"
      role="button"
      tabIndex={0}
      title={label}
      aria-label={label}
      data-ports={props.count}
      onClick={(e) => {
        e.stopPropagation();
        props.onOpen({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
        props.onOpen({ x: box.left, y: box.bottom });
      }}
    >
      <Icon name="plug" size={11} aria-hidden="true" />
      {props.count}
    </span>
  );
}

export interface PortsPopoverProps {
  ports: LivePort[];
  at: { x: number; y: number };
  /** The pid whose Stop asks for a second click. */
  confirming: number | null;
  onOpenBrowser(port: LivePort): void;
  onCopy(port: LivePort): void;
  /** First click on Stop: ask. */
  onAskStop(port: LivePort): void;
  /** Second click: stop it. */
  onStop(port: LivePort): void;
  onClose(): void;
}

/** The listeners of one worktree with their actions. */
export function PortsPopover(props: PortsPopoverProps): JSX.Element {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus(), []);
  const title = t("ports.title", { count: props.ports.length });
  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    props.onClose();
  };
  return (
    <>
      <div className="ws-menu-backdrop" data-action="ports-backdrop" onClick={props.onClose} />
      <div className="ws-ports-pop" ref={root} role="dialog" aria-label={title} tabIndex={-1} onKeyDown={key} style={{ left: props.at.x, top: props.at.y }}>
        <span className="ws-ports-title">{title}</span>
        <ul className="ws-ports-list">
          {props.ports.map((p) => (
            <li key={`${p.address}:${p.port}:${p.pid}`} className="ws-ports-row" data-port={p.port}>
              <span className="ws-ports-info">
                <span className="ws-ports-port">{p.port}</span>
                <span className="ws-ports-meta">
                  {p.process ?? t("ports.pid", { pid: p.pid })} - {p.address}
                </span>
              </span>
              <span className="ws-ports-actions">
                <button type="button" className="btn-secondary" data-action="open" onClick={() => props.onOpenBrowser(p)}>
                  {t("ports.open")}
                </button>
                <button type="button" className="btn-secondary" data-action="copy" onClick={() => props.onCopy(p)}>
                  {t("ports.copyAt", { address: endpoint(p) })}
                </button>
                {props.confirming === p.pid ? (
                  <button type="button" className="btn-secondary ws-ports-stop" data-action="stop-confirm" onClick={() => props.onStop(p)}>
                    {t("ports.stopConfirm", { port: p.port })}
                  </button>
                ) : (
                  <button type="button" className="btn-secondary ws-ports-stop" data-action="stop" onClick={() => props.onAskStop(p)}>
                    {t("ports.stop")}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
