import { expect, it } from "vitest";
import type { MenuItem } from "@/ui/ContextMenu";
import type { Tab } from "@/workspace/sessions";
import type { TerminalHandle } from "./Terminal";
import { terminalMenuItems, type TerminalMenuContext } from "./terminalMenu";

function setup(over: { selection?: boolean; paneId?: string | null; agent?: boolean } = {}) {
  const calls: string[] = [];
  const handle: TerminalHandle = {
    copy: async () => void calls.push("copy") ?? true,
    paste: async () => void calls.push("paste"),
    selectAll: () => void calls.push("selectAll"),
    clear: () => void calls.push("clear"),
    reset: () => void calls.push("reset"),
    find: () => void calls.push("find"),
    hasSelection: () => over.selection ?? true,
    focus: () => void calls.push("focus"),
    lines: () => [],
  };
  const ctx: TerminalMenuContext = {
    handle,
    tab: { id: "t1", agent: over.agent ?? false } as Tab,
    paneId: over.paneId === undefined ? "p1" : over.paneId,
    split: (dir) => void calls.push(`split:${dir}`),
    setTitle: () => void calls.push("setTitle"),
    close: () => void calls.push("close"),
    copyContext: () => void calls.push("copyContext"),
    copyTerminalId: () => void calls.push("copyTerminalId"),
    copyPaneId: () => void calls.push("copyPaneId"),
  };
  const items = terminalMenuItems(ctx);
  const find = (id: string) => items.find((i) => i.id === id) as MenuItem;
  return { calls, items, find };
}

it("lists the items in the reference order, separated into groups", () => {
  const { items } = setup();
  expect(items.map((i) => (i.kind === "separator" ? "-" : i.id))).toEqual([
    "copy", "paste", "selectAll", "-",
    "copyContext", "-",
    "splitRight", "splitDown", "-",
    "setTitle", "copyTerminalId", "copyPaneId", "-",
    "clear", "reset", "-",
    "close",
  ]);
  expect(items.filter((i) => i.kind !== "separator").every((i) => i.labelKey.startsWith("termMenu."))).toBe(true);
});

it("an agent tab gets the same items: Fork Agent Session is P2", () => {
  expect(setup({ agent: true }).items.map((i) => i.id)).toEqual(setup().items.map((i) => i.id));
  expect(setup({ agent: true }).items.some((i) => /fork/i.test(i.id))).toBe(false);
});

it("Copy is disabled without a selection", () => {
  expect(setup({ selection: false }).find("copy").disabled).toBe(true);
  expect(setup({ selection: true }).find("copy").disabled).toBeFalsy();
});

it("hides Copy Pane ID without a pane tree", () => {
  expect(setup({ paneId: null }).items.some((i) => i.id === "copyPaneId")).toBe(false);
});

it("each item calls its handle or context method", () => {
  const { calls, items } = setup();
  for (const item of items) item.run?.();
  expect(calls).toEqual([
    "copy", "paste", "selectAll", "copyContext", "split:right", "split:down",
    "setTitle", "copyTerminalId", "copyPaneId", "clear", "reset", "close",
  ]);
});

it("Close has no danger colour", () => {
  expect(setup().find("close").danger).toBeFalsy();
});

import en from "@/i18n/en.json";
import viText from "@/i18n/vi.json";
it("every label exists in en and vi", () => {
  for (const item of setup().items) {
    if (item.kind === "separator") continue;
    expect(en, item.labelKey).toHaveProperty([item.labelKey]);
    expect(viText, item.labelKey).toHaveProperty([item.labelKey]);
  }
});
