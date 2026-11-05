import { useEffect, useState } from "react";

/**
 * `value`, but only after it has stayed the same for `ms`. While `paused` it does not move at all
 * (a hidden view does no work); once resumed it catches up after the delay. `ms` 0 follows at once.
 */
export function useDebounced<T>(value: T, ms: number, paused = false): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (paused || Object.is(shown, value)) return;
    if (ms <= 0) {
      setShown(value);
      return;
    }
    const id = setTimeout(() => setShown(value), ms);
    return () => clearTimeout(id);
  }, [value, ms, paused, shown]);
  return shown;
}
