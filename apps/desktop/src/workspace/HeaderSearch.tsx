import { Icon } from "@xdev-asia/ui";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { useBindings } from "@/keys/bindingsStore";
import { chordLabel } from "@/keys/keymap";

/**
 * The search box in the middle of the header: a button with its shortcut. The `search.open` key
 * itself lives in the keymap; with `onJump` the button opens the jump palette and shows that chord.
 */
export function HeaderSearch(props: { onOpen: () => void; onJump?: () => void }): JSX.Element {
  const { onOpen, onJump } = props;
  const { t } = useI18n();
  // Read again when keybindings.json changes, so the hint follows a rebind.
  useBindings();
  const hint = chordLabel(onJump ? "palette.jump" : "search.open") ?? "";

  return (
    <button type="button" className="ws-search" onClick={onJump ?? onOpen}>
      <Icon name="magnifier" size={13} style={{ strokeWidth: 2 }} />
      <span className="ws-search-label">{t("workspace.header.search")}</span>
      {hint && <kbd className="ws-search-hint">{hint}</kbd>}
    </button>
  );
}
