// Which tabs show their conversation. Entry points (pane header, palette) open it; the dock in each
// tab pane reads it and closes it. Each open bumps a number, so opening an open view moves focus to it.
import { useSyncExternalStore } from "react";
import type { PaletteItem } from "@/palette/items";

let open = new Map<string, number>();
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of [...listeners]) fn();
}

export function openConversation(tab: string): void {
  open = new Map(open).set(tab, ++seq);
  emit();
}

export function closeConversation(tab: string): void {
  if (!open.has(tab)) return;
  const next = new Map(open);
  next.delete(tab);
  open = next;
  emit();
}

export function isConversationOpen(tab: string): boolean {
  return open.has(tab);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** 0 while `tab` does not show its conversation; else a number that changes on each open. */
export function useConversationOpen(tab: string): number {
  return useSyncExternalStore(
    subscribe,
    () => open.get(tab) ?? 0,
    () => 0,
  );
}

/** Whether a tab can show a conversation: an agent tab whose CLI session is known. */
export function canShowConversation(tab: { agent: boolean; agentSession: string | null }): boolean {
  return tab.agent && !!tab.agentSession;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** "Open conversation" for the tab in front, when it can show one. */
export function conversationItems(t: T, front: { id: string; agent: boolean; agentSession: string | null } | null | undefined): PaletteItem[] {
  if (!front || !canShowConversation(front)) return [];
  const id = front.id;
  return [
    {
      id: "conversation:open",
      kind: "action",
      title: t("conversation.palette.open"),
      keywords: t("conversation.palette.open.keywords").split(/\s+/).filter(Boolean),
      run: () => openConversation(id),
    },
  ];
}
