import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useKeymap } from "@/keys/keymap";
import { FloatingPanel } from "./FloatingPanel";
import { loadFloating, startFloatingSave } from "./floatingPersist";
import { toggleFloating, useFloating } from "./floatingStore";

/**
 * Owns the floating workspace: the `floating.toggle` key (in every view, in a terminal too) and the
 * panel, which is made on the first open and kept after, so its shells run while it is closed.
 */
export function FloatingHost(props: { api: Api }): JSX.Element | null {
  const { api } = props;
  const { open } = useFloating();
  const [started, setStarted] = useState(false);
  const [home, setHome] = useState<string | null>(null);
  const [homeError, setHomeError] = useState<string | null>(null);
  useKeymap({ "floating.toggle": toggleFloating });
  // The saved tabs come back at start, whether or not the panel is ever opened. The saver starts
  // after the load, so a first save never replaces a file that is not read yet.
  useEffect(() => {
    let stopped = false;
    let stop: (() => void) | null = null;
    void loadFloating(api).then(() => {
      if (!stopped) stop = startFloatingSave(api).stop;
    });
    return () => {
      stopped = true;
      stop?.();
    };
  }, [api]);
  useEffect(() => {
    if (!open || started) return;
    setStarted(true);
    api.homeDir().then(setHome, (e: unknown) => setHomeError(e instanceof Error ? e.message : String(e)));
  }, [open, started, api]);
  if (!open && !started) return null;
  return <FloatingPanel api={api} home={home} homeError={homeError} />;
}
