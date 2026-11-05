/** How long the pane a jump lands on stays marked. */
export const FLASH_MS = 900;

interface Timers {
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const running = new WeakMap<object, number>();

/** Marks an element `data-flash` for `ms`; a second call on the same element restarts the time. */
export function flash(el: { dataset: Record<string, string | undefined> } | null, ms: number = FLASH_MS, timers: Timers = window): void {
  if (!el) return;
  const old = running.get(el);
  if (old !== undefined) timers.clearTimeout(old);
  el.dataset.flash = "";
  running.set(
    el,
    timers.setTimeout(() => {
      delete el.dataset.flash;
      running.delete(el);
    }, ms),
  );
}
