import { useEffect, useRef, useSyncExternalStore } from "react";
import { NavHistory, type NavEntry } from "./navHistory";

/**
 * Feeds one `NavHistory` per shell from the selection (`current`, `tab`) and walks it. Going back or
 * forward only calls `go`; the selection that follows lands on the entry at the index, which `visit`
 * treats as a tab refresh, so no "navigating" flag is needed.
 */
export function useNavHistory(args: {
  current: string | null;
  tab: string | null;
  alive(worktree: string): boolean;
  go(entry: NavEntry): void;
}): { back(): boolean; forward(): boolean; canBack: boolean; canForward: boolean } {
  const { current, tab, alive, go } = args;
  const ref = useRef<NavHistory | null>(null);
  if (ref.current === null) ref.current = new NavHistory();
  const history = ref.current;
  useSyncExternalStore(history.subscribe.bind(history), history.version.bind(history));
  useEffect(() => {
    if (current !== null) history.visit(current, tab);
  }, [history, current, tab]);

  const walk = (entry: NavEntry | null): boolean => {
    if (entry === null) return false;
    go(entry);
    return true;
  };
  return {
    back: () => walk(history.back(alive)),
    forward: () => walk(history.forward(alive)),
    canBack: history.canBack(alive),
    canForward: history.canForward(alive),
  };
}
