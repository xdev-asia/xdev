import { dropPayloads, type TargetShell } from "./pathPaste";

export type DropEvent = {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  position?: { x: number; y: number };
};

type DropTarget = { write(data: string): Promise<void>; ready(): boolean; focus(): void };

const DROP_CLASS = "terminal-drop";

// Every terminal pane in this window, by its host element.
const targets = new Map<HTMLElement, DropTarget>();

/** A pane takes dropped files while registered; returns the unregister. */
export function registerDropTarget(host: HTMLElement, target: DropTarget): () => void {
  targets.set(host, target);
  return () => {
    if (targets.get(host) === target) targets.delete(host);
    host.classList.remove(DROP_CLASS);
  };
}

/**
 * One OS drag-and-drop listener for the window. Files dropped on a registered pane have their
 * paths written to its pty, in drop order; while they hover, the pane shows the `terminal-drop`
 * outline. Returns the stop.
 */
export function startFileDrop(deps: {
  /** The native events; positions are in physical pixels. */
  listen(cb: (e: DropEvent) => void): Promise<() => void>;
  /** Physical pixels per CSS pixel. */
  scale(): number;
  hit(x: number, y: number): Element | null;
  shell: TargetShell;
  /** A write failed. */
  onError(): void;
}): () => void {
  let marked: HTMLElement | null = null;

  const paneAt = (position: DropEvent["position"]): [HTMLElement, DropTarget] | null => {
    if (!position) return null;
    const scale = deps.scale() || 1;
    const el = deps.hit(position.x / scale, position.y / scale);
    if (!el) return null;
    for (const entry of targets) if (entry[0].contains(el)) return entry;
    return null;
  };
  const mark = (host: HTMLElement | null) => {
    if (marked === host) return;
    marked?.classList.remove(DROP_CLASS);
    host?.classList.add(DROP_CLASS);
    marked = host;
  };

  const handle = async (e: DropEvent): Promise<void> => {
    if (e.type === "leave") return mark(null);
    const pane = paneAt(e.position);
    if (e.type !== "drop") return mark(pane?.[0] ?? null);
    mark(null);
    if (!pane || !e.paths?.length || !pane[1].ready()) return;
    try {
      for (const data of dropPayloads(e.paths, deps.shell)) await pane[1].write(data);
    } catch {
      deps.onError();
      return;
    }
    pane[1].focus();
  };

  let stopped = false;
  let unlisten: (() => void) | null = null;
  deps.listen((e) => void handle(e)).then(
    (stop) => {
      if (stopped) stop();
      else unlisten = stop;
    },
    () => {},
  );
  return () => {
    stopped = true;
    unlisten?.();
    unlisten = null;
    mark(null);
  };
}
