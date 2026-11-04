import type { Api, AwakeView, KeepAwake } from "./api";

type PowerApi = Pick<Api, "keepAwake" | "keepAwakeSet" | "keepAwakeAgents" | "onKeepAwakeChanged">;

/** The part of the settings mock the power mock stores its mode in. */
type Store = Pick<Api, "agentsSettings" | "agentsSettingsPut">;

/** Like Rust `wants_awake`: on always, agent only while an agent works. */
export function wantsAwake(mode: KeepAwake, working: boolean): boolean {
  return mode === "on" || (mode === "agent" && working);
}

/** Keep awake in memory: the mode lives in the agents settings, an OS request is only counted. */
export function createMockPower(store: Store): PowerApi {
  let working = false;
  const listeners = new Set<(v: AwakeView) => void>();
  const view = async (): Promise<AwakeView> => {
    const { keepAwake: mode } = await store.agentsSettings();
    return { mode, held: wantsAwake(mode, working), supported: true };
  };
  const emit = async (before: AwakeView): Promise<AwakeView> => {
    const now = await view();
    if (now.mode !== before.mode || now.held !== before.held) for (const cb of listeners) cb(now);
    return now;
  };
  return {
    keepAwake: view,
    async keepAwakeSet(mode) {
      const before = await view();
      await store.agentsSettingsPut({ ...(await store.agentsSettings()), keepAwake: mode });
      return emit(before);
    },
    async keepAwakeAgents(next) {
      const before = await view();
      working = next;
      return emit(before);
    },
    async onKeepAwakeChanged(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}
