import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { chordLabel } from "@/keys/keymap";
import "./nav.css";

function Chevron(props: { dir: "left" | "right" }): JSX.Element {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d={props.dir === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

/** Back and forward through the worktrees visited, next to the sidebar toggle. */
export function NavButtons(props: { canBack: boolean; canForward: boolean; onBack(): void; onForward(): void }): JSX.Element {
  const { t } = useI18n();
  const title = (key: "back" | "forward", can: boolean): string => {
    if (!can) return t(`nav.${key}.none`);
    const chord = chordLabel(`worktree.history.${key}`);
    return chord ? `${t(`nav.${key}`)} (${chord})` : t(`nav.${key}`);
  };
  const back = title("back", props.canBack);
  const forward = title("forward", props.canForward);
  return (
    <span className="nav-buttons">
      <button type="button" className="ws-icon-btn nav-btn" aria-label={back} title={back} disabled={!props.canBack} onClick={props.onBack}>
        <Chevron dir="left" />
      </button>
      <button type="button" className="ws-icon-btn nav-btn" aria-label={forward} title={forward} disabled={!props.canForward} onClick={props.onForward}>
        <Chevron dir="right" />
      </button>
    </span>
  );
}
