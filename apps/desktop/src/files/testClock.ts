import type { Timers } from "./fileWatch";

/** Lets queued promise callbacks run. */
export const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A clock that only moves when the test says so; for tests. */
export function fakeTimers() {
  let now = 0;
  let next = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => {
      const id = next++;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (id) => void queue.delete(id as number),
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...queue.entries()].filter(([, q]) => q.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      queue.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await tick();
    }
    now = end;
    await tick();
  };
  return { timers, advance, pending: () => queue.size, now: () => now };
}
