import { StatusDot } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { NotchState } from "@/api";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** What a screen reader hears for the view; null when the strip is hidden. */
export function notchLabel(view: NotchState["view"], t: T): string | null {
  switch (view.kind) {
    case "needs-you":
      return view.others > 0 ? t("notch.needsYouMore", { name: view.name, count: view.others }) : t("notch.needsYou", { name: view.name });
    case "failed":
      return view.others > 0 ? t("notch.failedMore", { name: view.name, count: view.others }) : t("notch.failed", { name: view.name });
    case "working":
      return t("notch.working", { count: view.count });
    default:
      return null;
  }
}

export interface NotchViewProps {
  state: NotchState;
  t: T;
  /** A click: the main window comes forward on that tab. */
  onOpen(ptyId: string): void;
}

/**
 * The strip: the state on the left wing and the detail on the right, with the notch's width left
 * empty between them. Without a notch the two sit side by side in a pill.
 */
export function NotchView({ state, t, onOpen }: NotchViewProps): JSX.Element | null {
  const { view, gap } = state;
  const label = notchLabel(view, t);
  if (view.kind === "hidden" || label === null) return null;
  const dot = view.kind === "needs-you" ? <StatusDot state="waiting" /> : view.kind === "failed" ? <StatusDot state="failed" /> : <StatusDot state="working" pulse />;
  const main = view.kind === "working" ? t("notch.workingShort", { count: view.count }) : view.name;
  const detail =
    view.kind === "working"
      ? null
      : view.others > 0
        ? t("notch.more", { count: view.others })
        : t(view.kind === "needs-you" ? "notch.needsYouShort" : "notch.failedShort");
  return (
    <div className="notch" role="status" aria-label={label} data-kind={view.kind} data-notch={gap > 0 ? "" : undefined}>
      <button type="button" className="notch-hit" aria-label={t("notch.open", { label })} onClick={() => onOpen(view.ptyId)}>
        <span className="notch-wing notch-left">
          {dot}
          <span className="notch-text">{main}</span>
        </span>
        {gap > 0 ? <span className="notch-gap" style={{ width: gap }} aria-hidden="true" /> : null}
        <span className="notch-wing notch-right">{detail ? <span className="notch-detail">{detail}</span> : null}</span>
      </button>
    </div>
  );
}
