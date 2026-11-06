import { Menu, type MenuEntry } from "@xdev-asia/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";

export interface DefinitionTarget {
  rel: string;
  line: number;
  column: number;
}

/** A pick list of definitions at a point (the caret or the click); Escape or a click outside closes it. */
export function DefinitionPicker(props: { at: { x: number; y: number }; targets: DefinitionTarget[]; onPick(target: DefinitionTarget): void; onClose(): void }): JSX.Element {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [props.onClose]);
  const items: MenuEntry[] = [
    { type: "group", label: t("lsp.definitions") },
    ...props.targets.map((target): MenuEntry => ({ label: `${target.rel}:${target.line}`, onSelect: () => props.onPick(target) })),
  ];
  const left = Math.max(0, Math.min(props.at.x, window.innerWidth - 240));
  return (
    <div ref={box} className="lsp-picker" style={{ left, top: props.at.y }}>
      <Menu items={items} label={t("lsp.definitions")} onClose={props.onClose} />
    </div>
  );
}
