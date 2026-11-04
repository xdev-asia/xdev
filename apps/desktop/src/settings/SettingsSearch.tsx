import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { revealSetting } from "./SettingRow";

/** The search box above the section list. Ctrl+F or Cmd+F focuses it; Escape clears it. */
export function SettingsSearch(props: { value: string; onChange(query: string): void }): JSX.Element {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="settings-search">
      <input
        ref={input}
        type="search"
        className="settings-search-input"
        value={props.value}
        placeholder={t("settings.search.placeholder")}
        aria-label={t("settings.search.placeholder")}
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && props.value !== "") {
            e.preventDefault();
            e.stopPropagation();
            props.onChange("");
          }
        }}
      />
      {props.value !== "" && (
        <button type="button" className="settings-search-clear" aria-label={t("settings.search.clear")} onClick={() => props.onChange("")}>
          ×
        </button>
      )}
    </div>
  );
}

/** Scrolls the control a palette item asked for into view, once, when the page is up. Draws nothing. */
export function RevealSetting(props: { id: string }): null {
  useEffect(
    () => revealSetting(() => document.querySelector<HTMLElement>(`[data-setting-id="${props.id.replace(/"/g, "")}"]`)),
    [props.id],
  );
  return null;
}
