/** The window calls the custom title bar makes. Outside Tauri they do nothing. */
export interface WindowControls {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Calls `listener` when the window is resized; returns the unsubscribe. */
  onResized(listener: () => void): Promise<() => void>;
}

async function current() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export const windowControls: WindowControls = {
  minimize: async () => void (await (await current())?.minimize()),
  toggleMaximize: async () => void (await (await current())?.toggleMaximize()),
  close: async () => void (await (await current())?.close()),
  isMaximized: async () => (await (await current())?.isMaximized()) ?? false,
  onResized: async (listener) => (await (await current())?.onResized(listener)) ?? (() => {}),
};
