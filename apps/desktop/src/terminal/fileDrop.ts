import type { TargetShell } from "./pathPaste";

export type DropEvent = {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  position?: { x: number; y: number };
};

export function registerDropTarget(
  _host: HTMLElement,
  _target: { write(data: string): Promise<void>; ready(): boolean; focus(): void },
): () => void {
  throw new Error("not implemented");
}

export function startFileDrop(_deps: {
  listen(cb: (e: DropEvent) => void): Promise<() => void>;
  scale(): number;
  hit(x: number, y: number): Element | null;
  shell: TargetShell;
  onError(): void;
}): () => void {
  throw new Error("not implemented");
}
