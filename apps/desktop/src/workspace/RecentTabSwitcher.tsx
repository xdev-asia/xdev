import { ListRow } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useI18n } from "@/i18n";

/** The popup waits this long before it shows, so a quick Ctrl+Tab tap switches without a flash. */
export const SWITCHER_DELAY_MS = 150;

/** One row of the switcher. */
export interface SwitcherItem {
  id: string;
  title: string;
  /** The kind mark: the agent letter, the file icon or a line icon. */
  icon: ReactNode;
  /** A file tab's path in the worktree. */
  path?: string;
}

/**
 * What a key does to an open switcher: `keyup` of Ctrl activates the highlighted tab, Escape cancels. A key
 * pressed without Ctrl means the Ctrl release went unseen, so it activates too.
 */
export function switcherKey(e: { type: string; key: string; ctrlKey: boolean }): "commit" | "cancel" | null {
  if (e.type === "keyup") return e.key === "Control" ? "commit" : null;
  if (e.key === "Escape") return "cancel";
  return e.ctrlKey ? null : "commit";
}

/**
 * The recent-tab list under Ctrl+Tab. Tab and Shift+Tab move `at` from outside (the keymap); this only draws the
 * list and tells when Ctrl is released (commit) or the walk is abandoned (cancel). Focus stays where it was.
 */
export function RecentTabSwitcher(props: {
  items: SwitcherItem[];
  at: number;
  /** Keys that moved the highlight so far; a second one shows the popup at once. */
  steps: number;
  onCommit: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { items, at, steps, onCommit, onCancel } = props;
  const { t } = useI18n();
  const [waited, setWaited] = useState(false);
  const shown = waited || steps > 1;
  const optionId = (i: number) => `ws-recent-${i}`;

  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), SWITCHER_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const verdict = switcherKey(e);
      if (verdict === null) return;
      if (verdict === "cancel") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else onCommit();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onCancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onCancel);
    };
  });
  useEffect(() => {
    document.getElementById(optionId(at))?.scrollIntoView?.({ block: "nearest" });
  }, [at, shown]);

  return (
    <div className="ws-recent" hidden={!shown}>
      <ul className="ws-recent-list" role="listbox" aria-label={t("workspace.tabs.switcher")} aria-activedescendant={optionId(at)}>
        {items.map((item, i) => (
          <li key={item.id} id={optionId(i)} role="option" aria-selected={i === at}>
            <ListRow leading={item.icon} title={item.title} meta={item.path} selected={i === at} />
          </li>
        ))}
      </ul>
    </div>
  );
}
