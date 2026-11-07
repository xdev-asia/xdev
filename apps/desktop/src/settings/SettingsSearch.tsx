import { useEffect } from "react";
import { revealSetting } from "./SettingRow";

/** Ctrl+F or Cmd+F focuses the search box of the Settings shell. */
export function useFindShortcut(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        const input = document.querySelector<HTMLInputElement>(".x-settings-shell-side input");
        if (!input) return;
        e.preventDefault();
        input.focus();
        input.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** The element of a setting: a wrapped row (`data-setting-id`) or a design-system row (`id`). */
function settingElement(id: string): HTMLElement | null {
  const safe = id.replace(/"/g, "");
  return document.querySelector<HTMLElement>(`[data-setting-id="${safe}"]`) ?? document.getElementById(safe);
}

/** Watches the page for changes; calls `notify` on each until the returned function is called. */
function watchDom(notify: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(notify);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/** Scrolls the control a palette item asked for into view, once, as soon as the page has it. Draws nothing. */
export function RevealSetting(props: { id: string }): null {
  useEffect(() => revealSetting(() => settingElement(props.id), watchDom), [props.id]);
  return null;
}
