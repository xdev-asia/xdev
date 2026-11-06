import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useKeymap } from "@/keys/keymap";
import { FloatingPanel } from "./FloatingPanel";
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
  useEffect(() => {
    if (!open || started) return;
    setStarted(true);
    api.homeDir().then(setHome, (e: unknown) => setHomeError(e instanceof Error ? e.message : String(e)));
  }, [open, started, api]);
  if (!open && !started) return null;
  return <FloatingPanel api={api} home={home} homeError={homeError} />;
}
