import { useRef } from "react";
import type { JSX, ReactNode } from "react";
import { useI18n } from "@/i18n";

/**
 * The Command button at the end of the tab strip. `children` is the popover, drawn while `open`;
 * closing it puts the keyboard back on the button.
 */
export function QuickCommandsButton(props: { open: boolean; onOpen(open: boolean): void; children?: ReactNode }): JSX.Element {
  const { t } = useI18n();
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className="qc-anchor">
      <button
        ref={button}
        type="button"
        className="qc-button"
        aria-haspopup="dialog"
        aria-expanded={props.open}
        title={t("qcmd.buttonLabel")}
        onClick={() => props.onOpen(!props.open)}
      >
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 8 5 4-5 4M12 17h7" />
        </svg>
        <span>{t("qcmd.button")}</span>
      </button>
      {props.open && (
        <>
          <div
            className="ws-menu-backdrop"
            onClick={() => {
              props.onOpen(false);
              button.current?.focus();
            }}
          />
          <div
            className="qc-pop-slot"
            onKeyDownCapture={(e) => {
              if (e.key === "Escape") queueMicrotask(() => button.current?.focus());
            }}
          >
            {props.children}
          </div>
        </>
      )}
    </div>
  );
}
