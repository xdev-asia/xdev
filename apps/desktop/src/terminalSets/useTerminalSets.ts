import { useCallback, useEffect, useState } from "react";
import type { Api, StartupPreset, TerminalSet } from "@/api";

/** The saved sets and startup presets, kept current by `settings://changed`. */
export function useTerminalSets(api: Api): { sets: TerminalSet[]; presets: StartupPreset[]; reload(): void } {
  const [sets, setSets] = useState<TerminalSet[]>([]);
  const [presets, setPresets] = useState<StartupPreset[]>([]);
  const reload = useCallback(() => {
    void api.terminalSetsList().then(setSets, () => {});
    void api.startupPresetsList().then(setPresets, () => {});
  }, [api]);
  useEffect(() => {
    reload();
    return api.onSettingsChanged((e) => {
      if (e.sections.includes("terminalSets")) reload();
    });
  }, [api, reload]);
  return { sets, presets, reload };
}
