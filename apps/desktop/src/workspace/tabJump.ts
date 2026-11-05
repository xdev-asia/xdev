/** Lets Settings ask the workspace to show the tab of a terminal, without either importing the other. */
type Jump = (ptyId: string) => boolean;

const handlers = new Set<Jump>();

/** Asks the workspace to focus the tab of `ptyId`; false when no tab holds it. */
export function requestTabJump(ptyId: string): boolean {
  for (const jump of handlers) if (jump(ptyId)) return true;
  return false;
}

/** Registers a handler: true when it knows the tab and focused it. Returns how to remove it. */
export function onTabJump(fn: Jump): () => void {
  handlers.add(fn);
  return () => void handlers.delete(fn);
}
