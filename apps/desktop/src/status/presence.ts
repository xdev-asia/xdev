import { useEffect, useState } from "react";

/** A pane counts as seen only if the person did something in the window within this long. */
export const PRESENCE_MS = 180_000;

const EVENTS = ["keydown", "pointerdown", "wheel"] as const;

type Target = Pick<Window, "addEventListener" | "removeEventListener">;

/**
 * Tells `onChange` whether the person is at the window: true from the start and after each trusted
 * keydown, pointerdown or wheel, false once `ttl` passes without one. Scripted events (`isTrusted`
 * false) prove nothing. The window's own focus is tracked elsewhere; seen needs both.
 */
export function watchPresence(
  target: Target,
  onChange: (present: boolean) => void,
  ttl: number = PRESENCE_MS,
  now: () => number = () => Date.now(),
): () => void {
  let present = true;
  let last = now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const arm = (ms: number) => {
    timer = setTimeout(() => {
      timer = null;
      const left = last + ttl - now();
      // Input came since the timer was set: wait for what is left of its window.
      if (left > 0) return arm(left);
      present = false;
      onChange(false);
    }, ms);
  };
  const touch = (e: Event) => {
    if (!e.isTrusted) return;
    last = now();
    if (!present) {
      present = true;
      onChange(true);
    }
    if (!timer) arm(ttl);
  };

  arm(ttl);
  for (const name of EVENTS) target.addEventListener(name, touch, { capture: true, passive: true });
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const name of EVENTS) target.removeEventListener(name, touch, { capture: true });
  };
}

/** Whether the person is at the window (see `watchPresence`). */
export function usePresence(): boolean {
  const [present, setPresent] = useState(true);
  useEffect(() => (typeof window === "undefined" ? undefined : watchPresence(window, setPresent)), []);
  return present;
}
