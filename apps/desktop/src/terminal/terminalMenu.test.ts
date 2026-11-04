import { expect, it } from "vitest";
import type { MenuItem } from "@/ui/ContextMenu";
import type { Tab } from "@/workspace/sessions";
import type { TerminalHandle } from "./Terminal";
import { terminalMenuItems, type TerminalMenuContext } from "./terminalMenu";

function setup(over: { selection?: boolean; paneId?: string | null; agent?: boolean; fork?: boolean; session?: string | null } = {}) {
  const calls: string[] = [];
  const handle: TerminalHandle = {
    copy: async () => { calls.push("copy"); return true; },
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
    tab: { id: "t1", agent: over.agent ?? false, agentSession: over.session === undefined ? null : over.session } as Tab,
    paneId: over.paneId === undefined ? "p1" : over.paneId,
    split: (dir) => void calls.push(`split:${dir}`),
    setTitle: () => void calls.push("setTitle"),
    close: () => void calls.push("close"),
    copyContext: () => void calls.push("copyContext"),
    copyTerminalId: () => void calls.push("copyTerminalId"),
    copyPaneId: () => void calls.push("copyPaneId"),
    ...(over.fork ? { forkSession: () => void calls.push("forkSession") } : {}),
  };
  const items = terminalMenuItems(ctx);
  const find = (id: string) => items.find((i) => i.id === id) as MenuItem;
  return { calls, items, find, ctx };
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

it("Fork session sits after Quick Commands and before Copy Context; it is hidden when the context has none", () => {
  expect(setup({ agent: true }).items.some((i) => i.id === "forkSession")).toBe(false);
  const ids = setup({ agent: true, fork: true, session: "abc" }).items.map((i) => i.id);
  expect(ids.indexOf("forkSession")).toBe(ids.indexOf("copyContext") - 1);
});

it("Fork session is disabled while the tab has no session id, and runs the context's fork", () => {
  expect(setup({ agent: true, fork: true, session: null }).find("forkSession").disabled).toBe(true);
  const on = setup({ agent: true, fork: true, session: "abc" });
  expect(on.find("forkSession").disabled).toBeFalsy();
  on.find("forkSession").run!();
  expect(on.calls).toEqual(["forkSession"]);
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

import { chordLabel } from "@/keys/keymap";

function withExtras(quick?: MenuItem) {
  const base = setup();
  // Same context as `setup`, plus the submenu.
  return terminalMenuItems({ ...base.ctx, quickCommands: quick });
}

it("shows the chord of every item that has an action, from the keys registry", () => {
  const { find } = setup();
  expect(find("copy").chord).toBe(chordLabel("terminal.copy") ?? undefined);
  expect(find("paste").chord).toBe(chordLabel("terminal.paste") ?? undefined);
  expect(find("splitRight").chord).toBe(chordLabel("pane.splitRight") ?? undefined);
  expect(find("splitRight").chord).toBeTruthy();
  expect(find("clear").chord).toBe(chordLabel("terminal.clear") ?? undefined);
  expect(find("close").chord).toBe(chordLabel("tab.close") ?? undefined);
  expect(find("setTitle").chord).toBeUndefined();
});

it("puts the Quick Commands submenu before Copy Context, and leaves it out without one", () => {
  const sub: MenuItem = { id: "quickCommands", labelKey: "termMenu.quickCommands", children: [] };
  const ids = (items: MenuItem[]) => items.map((i) => (i.kind === "separator" ? "-" : i.id));
  const withSub = ids(withExtras(sub));
  expect(withSub.slice(withSub.indexOf("quickCommands"), withSub.indexOf("quickCommands") + 2)).toEqual(["quickCommands", "copyContext"]);
  expect(ids(withExtras())).not.toContain("quickCommands");
});
