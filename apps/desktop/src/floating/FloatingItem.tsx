import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { chordLabel } from "@/keys/keymap";
import { toggleFloating, useFloating } from "./floatingStore";

/** The footer item that shows or hides the floating workspace. */
export function FloatingItem(): JSX.Element {
  const { t } = useI18n();
  const { open, tabs } = useFloating();
  const keys = chordLabel("floating.toggle");
  return (
    <button
      type="button"
      className="ws-footer-link"
      data-action="floating"
      aria-pressed={open}
      title={keys === null ? t("floating.title") : t("floating.statusTitle", { keys })}
      onClick={() => toggleFloating()}
    >
      {tabs.length === 0 ? t("floating.status") : t("floating.statusCount", { count: tabs.length })}
    </button>
  );
}
