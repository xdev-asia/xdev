import type { ITerminalAddon, Terminal as XTerm } from "@xterm/xterm";
import type { TerminalGpu } from "@/api";

/** What the renderer needs of the WebGL addon (the real one has more). */
export interface WebglLike {
  onContextLoss(listener: () => void): unknown;
  dispose(): void;
}

export type WebglLoader = () => Promise<{ WebglAddon: new () => WebglLike }>;

// The addon is its own chunk: it is fetched when a pane first asks for WebGL, not in the first bundle.
const loadWebgl: WebglLoader = () => import("@xterm/addon-webgl");

/**
 * Keeps one xterm on the WebGL renderer or the DOM one, as `gpu` says. Any failure ends on the
 * DOM renderer (xterm 6 has no canvas one), never on a blank pane. Call after `term.open`.
 *
 * - `auto`: WebGL; on a load error or a lost context the pane stays on DOM.
 * - `on`: WebGL; after one lost context it tries once more, then DOM.
 * - `off`: DOM; the addon is never loaded.
 */
export function attachRenderer(
  term: XTerm,
  gpu: TerminalGpu,
  load: WebglLoader = loadWebgl,
): { set(gpu: TerminalGpu): void; active(): "webgl" | "dom"; dispose(): void } {
  let mode = gpu;
  let addon: WebglLike | null = null;
  let losses = 0;
  let disposed = false;
  // A load that finishes after a newer request, or after dispose, is dropped.
  let generation = 0;

  const drop = () => {
    const old = addon;
    addon = null;
    try {
      old?.dispose();
    } catch {
      // A context that is already gone may throw on dispose; the pane is on DOM either way.
    }
  };

  const start = () => {
    if (disposed || mode === "off") return;
    const mine = ++generation;
    void load().then(
      ({ WebglAddon }) => {
        if (disposed || mine !== generation) return;
        let next: WebglLike | null = null;
        try {
          next = new WebglAddon();
          const made = next;
          made.onContextLoss(() => {
            if (addon !== made) return;
            drop();
            // `on` gets one more try; `auto` gives up for this pane.
            if (mode === "on" && losses++ < 1) start();
          });
          term.loadAddon(made as unknown as ITerminalAddon);
          addon = made;
        } catch {
          try {
            next?.dispose();
          } catch {
            // Nothing left to undo.
          }
        }
      },
      () => {},
    );
  };

  start();

  return {
    set(next) {
      if (disposed || next === mode) return;
      mode = next;
      losses = 0;
      generation++;
      drop();
      start();
    },
    active: () => (addon ? "webgl" : "dom"),
    dispose() {
      disposed = true;
      generation++;
      drop();
    },
  };
}
