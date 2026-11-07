// The one way other code opens a file: say so here, and the worktree's shell puts the file tab in
// its focused pane (or selects it when it is open already).
export interface OpenFileRequest {
  worktree: string;
  rel: string;
  line?: number;
  column?: number;
  /** Open the file tab in a new pane to the right of the focused pane. */
  side?: boolean;
}

const listeners = new Set<(req: OpenFileRequest) => void>();

/** Tells every listener, in the order they started listening. */
export function openFile(req: OpenFileRequest): void {
  for (const fn of [...listeners]) fn(req);
}

/** Calls `fn` for every `openFile`; returns the way to stop. */
export function onOpenFile(fn: (req: OpenFileRequest) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
