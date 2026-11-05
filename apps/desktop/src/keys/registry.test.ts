import { expect, it } from "vitest";
import en from "@/i18n/en.json";
import vi from "@/i18n/vi.json";
import type { Platform } from "@/platform";
import { normalizeChord } from "./keybindingsFile";
import { DEFAULT_BINDINGS, type ActionId } from "./keymap";
import { defaultsFor, SHORTCUTS, shortcutDef } from "./registry";

const PLATFORMS: Platform[] = ["win", "mac", "linux"];

// Every ActionId; the type check fails when the union grows and this list does not.
const ALL: Record<ActionId, true> = {
  "tab.new": true, "tab.close": true, "tab.next": true, "tab.prev": true,
  "tab.select.1": true, "tab.select.2": true, "tab.select.3": true, "tab.select.4": true, "tab.select.5": true,
  "tab.select.6": true, "tab.select.7": true, "tab.select.8": true, "tab.select.9": true,
  "pane.splitRight": true, "pane.splitDown": true, "pane.next": true, "pane.prev": true,
  "pane.expand": true, "pane.equalize": true, "pane.close": true,
  "worktree.next": true, "worktree.prev": true, "worktree.history.back": true, "worktree.history.forward": true,
  "worktree.select.1": true, "worktree.select.2": true, "worktree.select.3": true, "worktree.select.4": true,
  "worktree.select.5": true, "worktree.select.6": true, "worktree.select.7": true, "worktree.select.8": true,
  "worktree.select.9": true,
  "agent.new": true, "palette.jump": true, "search.open": true, "sessions.open": true,
  "sidebar.left.toggle": true, "sidebar.right.toggle": true,
  "panel.explorer": true, "panel.search": true, "panel.sourceControl": true, "panel.issues": true, "panel.ports": true,
  "terminal.clear": true, "terminal.copy": true, "terminal.paste": true, "terminal.selectAll": true, "terminal.find": true,
  "zoom.in": true, "zoom.out": true, "zoom.reset": true,
  "tab.reopenClosed": true, "tab.nextSameKind": true, "tab.prevSameKind": true, "file.closeAll": true, "tab.closeAll": true,
  "settings.open": true, "settings.shortcuts": true,
  "docs.search": true, "docs.new": true, "docs.save": true, "file.save": true, "file.markdownPreview": true,
  "quickCommands.open": true, "quickOpen.open": true,
};

it("every ActionId has exactly one def", () => {
  const ids = SHORTCUTS.map((d) => d.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(Object.keys(ALL).sort());
});

it("every title and group has an English and a Vietnamese text", () => {
  const texts = [en as Record<string, string>, vi as Record<string, string>];
  for (const d of SHORTCUTS) {
    expect(d.titleKey).toBe(`keys.action.${d.id}`);
    for (const t of texts) {
      expect(t[d.titleKey], d.titleKey).toBeTruthy();
      expect(t[`keys.group.${d.group}`], d.group).toBeTruthy();
    }
  }
});

it("every default chord parses on every platform", () => {
  for (const p of PLATFORMS) {
    for (const d of SHORTCUTS) {
      for (const chord of defaultsFor(d, p)) expect(normalizeChord(chord, p), `${d.id} ${chord} ${p}`).not.toBeNull();
    }
  }
});

it("no two defaults in one scope share a chord on any platform", () => {
  for (const p of PLATFORMS) {
    const seen = new Map<string, ActionId>();
    for (const d of SHORTCUTS) {
      for (const chord of defaultsFor(d, p)) {
        const key = `${d.scope} ${normalizeChord(chord, p)}`;
        expect(seen.get(key), `${key} on ${p}: ${d.id}`).toBeUndefined();
        seen.set(key, d.id);
      }
    }
  }
});

it("the keys a TUI also uses are the ones that yield under terminal first", () => {
  expect(SHORTCUTS.filter((d) => d.yieldsToTerminal).map((d) => d.id).sort()).toEqual(
    ["pane.close", "pane.next", "pane.prev", "pane.splitDown", "pane.splitRight", "terminal.clear", "terminal.find", "terminal.selectAll", "worktree.history.back", "worktree.history.forward"],
  );
});

// The list panes-tabs-keys shipped. On macOS its Ctrl turned into Cmd but for these three.
const OLD: [ActionId, string][] = [
  ["tab.new", "Ctrl+T"], ["tab.close", "Ctrl+W"], ["tab.next", "Ctrl+Tab"], ["tab.prev", "Ctrl+Shift+Tab"],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): [ActionId, string] => [`tab.select.${n}` as ActionId, `Alt+${n}`]),
  ["pane.splitRight", "Ctrl+Shift+D"], ["pane.splitDown", "Alt+Shift+D"], ["pane.next", "Ctrl+]"], ["pane.prev", "Ctrl+["],
  ["pane.expand", "Ctrl+Shift+Enter"], ["pane.equalize", "Ctrl+Shift+="],
  ["worktree.prev", "Ctrl+Shift+Up"], ["worktree.next", "Ctrl+Shift+Down"],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): [ActionId, string] => [`worktree.select.${n}` as ActionId, `Ctrl+${n}`]),
  ["agent.new", "Ctrl+Alt+T"], ["palette.jump", "Ctrl+J"],
];
const KEPT_CTRL = new Set<ActionId>(["tab.next", "tab.prev", "agent.new"]);

it("the panes-tabs-keys defaults are unchanged on every platform", () => {
  for (const p of PLATFORMS) {
    for (const [id, chord] of OLD) {
      const old = p === "mac" && !KEPT_CTRL.has(id) ? chord.replace("Ctrl", "Mod") : chord;
      const d = SHORTCUTS.find((s) => s.id === id)!;
      // tab.next / tab.prev have since gained extra chords; the first one is still the old key.
      expect(defaultsFor(d, p).map((c) => normalizeChord(c, p))[0], `${id} ${p}`).toBe(normalizeChord(old, p));
    }
  }
});

it("DEFAULT_BINDINGS holds the old list, normalized, for the panes-tabs-keys actions", () => {
  for (const [id, chord] of OLD) {
    expect(DEFAULT_BINDINGS.filter((b) => b.action === id).map((b) => b.chord)[0], id).toBe(normalizeChord(chord, "win"));
  }
});

it("file-tab commands: Mod+Shift+T reopens, Close all editors has no default key", () => {
  expect(defaultsFor(shortcutDef("tab.reopenClosed")!, "linux")).toEqual(["Mod+Shift+T"]);
  const d = shortcutDef("file.closeAll")!;
  expect(defaultsFor(d, "linux")).toEqual([]);
  expect(defaultsFor(d, "mac")).toEqual([]);
  expect(d.scope).toBe("global");
});

const on = (id: ActionId, p: Platform) => defaultsFor(shortcutDef(id)!, p).map((c) => normalizeChord(c, p));

it("tab keys: close all, cycle by kind, next and previous across every tab", () => {
  expect(on("tab.closeAll", "win")).toEqual(["Ctrl+Alt+W"]);
  expect(on("tab.closeAll", "mac")).toEqual(["Alt+Cmd+W"]);
  expect(on("tab.nextSameKind", "linux")).toEqual(["Ctrl+Alt+]"]);
  expect(on("tab.prevSameKind", "mac")).toEqual(["Alt+Cmd+["]);
  expect(on("tab.next", "win")).toEqual(["Ctrl+Tab", "Ctrl+Shift+]", "Ctrl+PageDown"]);
  expect(on("tab.prev", "mac")).toEqual(["Ctrl+Shift+Tab", "Shift+Cmd+[", "Ctrl+PageUp"]);
  // Ctrl stays Ctrl on every platform for the page keys.
  expect(on("tab.next", "mac")).toContain("Ctrl+PageDown");
});

it("Mod+W stays with Close tab; Close pane has no second claim on it", () => {
  for (const p of PLATFORMS) {
    expect(on("tab.close", p)).toEqual([normalizeChord("Mod+W", p)]);
    expect(on("pane.close", p)).toEqual([]);
  }
});

it("the KB-3 keys and the macOS terminal copy and paste", () => {
  expect(on("sidebar.left.toggle", "win")).toEqual(["Ctrl+B"]);
  expect(on("zoom.in", "win")).toEqual(["Ctrl+=", "Ctrl+NumpadAdd"]);
  expect(on("zoom.reset", "mac")).toEqual(["Cmd+0"]);
  expect(on("terminal.copy", "win")).toEqual(["Ctrl+Shift+C"]);
  expect(on("terminal.copy", "mac")).toEqual(["Cmd+C"]);
  expect(on("terminal.paste", "linux")).toEqual(["Ctrl+Shift+V", "Shift+Insert"]);
  expect(on("terminal.paste", "mac")).toEqual(["Cmd+V"]);
  expect(on("panel.ports", "mac")).toEqual(["Shift+Cmd+I"]);
  expect(on("panel.ports", "win")).toEqual([]);
  expect(on("terminal.clear", "win")).toEqual(["Ctrl+K"]);
  expect(on("settings.open", "win")).toEqual(["Ctrl+,"]);
  expect(on("quickCommands.open", "win")).toEqual(["Ctrl+Shift+;"]);
});
