import type { Extension } from "@codemirror/state";
import { useSyncExternalStore } from "react";

/** What a plugin knows about the editor it extends. */
export interface EditorPluginContext {
  worktree: string;
  rel: string;
  /** True for the second view of a file (`view:<rel>`). */
  secondary: boolean;
}

export type EditorPlugin = (ctx: EditorPluginContext) => Extension;

const plugins = new Map<string, EditorPlugin>();
const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version++;
  for (const fn of [...listeners]) fn();
}

/** Adds a plugin (the same id replaces the old one); returns the way to remove it. */
export function registerEditorPlugin(id: string, plugin: EditorPlugin): () => void {
  plugins.set(id, plugin);
  bump();
  return () => {
    if (plugins.get(id) !== plugin) return;
    plugins.delete(id);
    bump();
  };
}

/** Counts every register and unregister. */
export function editorPluginsVersion(): number {
  return version;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

const cache = new Map<string, { version: number; ext: Extension }>();

/** The extensions of every registered plugin for `ctx`; a new value when the set of plugins changes. */
export function useEditorPlugins(ctx: EditorPluginContext): Extension {
  const v = useSyncExternalStore(subscribe, editorPluginsVersion, editorPluginsVersion);
  const key = `${ctx.worktree}\0${ctx.rel}\0${ctx.secondary}`;
  const hit = cache.get(key);
  if (hit && hit.version === v) return hit.ext;
  const ext = [...plugins.values()].map((p) => p(ctx));
  cache.set(key, { version: v, ext });
  return ext;
}
