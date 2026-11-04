/**
 * Runs `load` at most once and hands every caller the same promise. `crashTakePending` marks the
 * report dismissed as it hands it out, so a second effect run (StrictMode in dev) must reuse the
 * first answer instead of asking again and getting nothing.
 */
export function takeOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => (pending ??= load());
}
