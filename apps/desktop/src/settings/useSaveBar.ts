import { useEffect, useRef } from "react";
import type { SaveSpec, SettingsSectionProps } from "./sections";

/**
 * Hands the Settings view this page's save state so its SaveBar shows while `dirty`. Returns true
 * when the view takes the save (the page then draws no Save button of its own).
 */
export function useSaveBar(props: Pick<SettingsSectionProps, "registerSave">, state: Omit<SaveSpec, "onSave" | "onDiscard"> & { onSave(): void; onDiscard(): void }): boolean {
  const { registerSave } = props;
  const latest = useRef(state);
  latest.current = state;
  const { dirty, busy, saveDisabled } = state;
  useEffect(() => {
    registerSave?.({ dirty, busy, saveDisabled, onSave: () => latest.current.onSave(), onDiscard: () => latest.current.onDiscard() });
  }, [registerSave, dirty, busy, saveDisabled]);
  useEffect(() => () => registerSave?.(null), [registerSave]);
  return registerSave !== undefined;
}
