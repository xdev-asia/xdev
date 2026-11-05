import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { ResourceManager, type ResourceTab } from "./ResourceManager";
import { onResourceManagerOpen } from "./resourceEvents";

/** Opens the resource manager when the palette or the usage page asks. */
export function ResourceHost(props: { api: Pick<Api, "resourcesSnapshot">; tabs(): ResourceTab[]; onStop(id: string): Promise<void> }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  useEffect(() => onResourceManagerOpen(() => setOpen(true)), []);
  return open ? <ResourceManager api={props.api} tabs={props.tabs} onStop={props.onStop} onClose={() => setOpen(false)} /> : null;
}
