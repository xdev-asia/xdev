export const PORTS_POLL_MS = 5_000;

/**
 * Runs `scan` now and then every `everyMs`, one scan at a time: a tick that
 * finds the last scan still running is skipped. Returns the stop function.
 */
export function startPortsPoll(scan: () => Promise<void>, everyMs: number = PORTS_POLL_MS): () => void {
  let running = false;
  let stopped = false;
  const tick = (): void => {
    if (running || stopped) return;
    running = true;
    void scan()
      .catch(() => {
        // The next tick tries again.
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, everyMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
