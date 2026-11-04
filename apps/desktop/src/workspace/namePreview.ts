import type { NamePreview } from "@/api";

/** How long a name must sit still before the preview asks the backend. */
export const PREVIEW_DELAY_MS = 200;

/**
 * Asks `load` for the name a create would get, `PREVIEW_DELAY_MS` after the last call, and hands the
 * answer to `onResult`. A blank name has nothing to show and a failed lookup shows nothing (Create
 * still validates), so both give `null`. The returned function drops a pending or late answer.
 */
export function schedulePreview(
  load: (repoId: string, name: string) => Promise<NamePreview>,
  repoId: string,
  name: string,
  onResult: (preview: NamePreview | null) => void,
): () => void {
  if (repoId === "" || name.trim() === "") {
    onResult(null);
    return () => {};
  }
  let live = true;
  const timer = setTimeout(() => {
    load(repoId, name).then(
      (preview) => live && onResult(preview),
      () => live && onResult(null),
    );
  }, PREVIEW_DELAY_MS);
  return () => {
    live = false;
    clearTimeout(timer);
  };
}
