import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { Menu, Popover, type MenuEntry } from "@xdev-asia/ui";

/** A button that opens a menu under it. Picking an item closes the menu first, then runs it. */
export function MenuButton(props: {
  label: string;
  items: MenuEntry[];
  /** What the button shows; defaults to its label. */
  children?: ReactNode;
  className?: string;
  placement?: "bottom-start" | "bottom-end";
  action?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const items = props.items.map((it): MenuEntry => {
    if (it.type === "separator" || it.type === "group" || !it.onSelect) return it;
    const run = it.onSelect;
    return {
      ...it,
      onSelect: () => {
        setOpen(false);
        run();
      },
    };
  });
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      placement={props.placement ?? "bottom-end"}
      label={props.label}
      trigger={(triggerProps) => (
        <button type="button" className={props.className ?? "ws-btn"} aria-label={props.label} data-act={props.action} {...triggerProps} onClick={() => setOpen(!open)}>
          {props.children ?? props.label}
        </button>
      )}
    >
      <Menu items={items} label={props.label} />
    </Popover>
  );
}
