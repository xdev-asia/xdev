import { describe, expect, it } from "vitest";
import { conflicts, mergeBindings, normalizeChord, parseKeybindings, serializeKeybindings } from "./keybindingsFile";
import type { ActionId, EffectiveBinding } from "./keymap";

describe("normalizeChord", () => {
  it("puts modifiers in a fixed order and reads any case", () => {
    expect(normalizeChord("ctrl+shift+t", "win")).toBe("Ctrl+Shift+T");
    expect(normalizeChord("Shift + Alt + ctrl + k", "linux")).toBe("Ctrl+Alt+Shift+K");
    expect(normalizeChord("cmd+shift+ctrl+alt+d", "mac")).toBe("Ctrl+Alt+Shift+Cmd+D");
  });

  it("resolves Mod per platform; Cmd is macOS only", () => {
    expect(normalizeChord("Mod+J", "win")).toBe("Ctrl+J");
    expect(normalizeChord("Mod+J", "mac")).toBe("Cmd+J");
    expect(normalizeChord("Cmd+J", "win")).toBeNull();
    expect(normalizeChord("Meta+J", "mac")).toBe("Cmd+J");
  });

  it("knows key and code names", () => {
    expect(normalizeChord("Ctrl+ArrowUp", "win")).toBe("Ctrl+Up");
    expect(normalizeChord("ctrl+keyb", "win")).toBe("Ctrl+B");
    expect(normalizeChord("Ctrl+Digit3", "win")).toBe("Ctrl+3");
    expect(normalizeChord("Ctrl+numpadadd", "win")).toBe("Ctrl+NumpadAdd");
    expect(normalizeChord("Ctrl+Equal", "win")).toBe("Ctrl+=");
    expect(normalizeChord("Ctrl+esc", "win")).toBe("Ctrl+Escape");
    expect(normalizeChord("Ctrl+Tab", "win")).toBe("Ctrl+Tab");
    expect(normalizeChord("f1", "win")).toBe("F1");
    expect(normalizeChord("Shift+Insert", "win")).toBe("Shift+Insert");
  });

  it("reads Plus as Shift+=", () => {
    expect(normalizeChord("Ctrl+Plus", "win")).toBe("Ctrl+Shift+=");
    expect(normalizeChord("Ctrl++", "win")).toBe("Ctrl+Shift+=");
  });

  it("refuses what is no shortcut", () => {
    for (const raw of ["", "Ctrl", "Ctrl+", "Ctrl+Banana", "T", "Shift+T", "Ctrl+T+Y", "Hyper+T", "Ctrl++T"]) {
      expect(normalizeChord(raw, "win"), raw).toBeNull();
    }
  });
});

const file = (body: unknown) => JSON.stringify(body);

describe("parseKeybindings", () => {
  it("reads comments and trailing commas", () => {
    const text = `{
      // my keys
      "version": 1, /* block */
      "keybindings": {
        "tab.new": ["ctrl+alt+n",], // trailing
        "tab.close": "Ctrl+Alt+Y", "my.url": "http://x//y, /* not a comment */",
      },
    }`;
    const { overrides, diagnostics } = parseKeybindings(text, "win");
    expect(diagnostics.map((d) => [d.kind, d.action])).toEqual([["unknownAction", "my.url"]]);
    expect(overrides.get("tab.close")).toEqual(["Ctrl+Alt+Y"]);
    expect(overrides.get("tab.new")).toEqual(["Ctrl+Alt+N"]);
  });

  it("takes a string as a one-item list and [] as disabled", () => {
    const { overrides } = parseKeybindings(file({ version: 1, keybindings: { "tab.new": "Ctrl+Alt+N", "terminal.clear": [] } }), "win");
    expect(overrides.get("tab.new")).toEqual(["Ctrl+Alt+N"]);
    expect(overrides.get("terminal.clear")).toEqual([]);
  });

  it("lets the platform section win", () => {
    const text = file({ version: 1, keybindings: { "tab.new": ["Ctrl+Alt+N"] }, mac: { "tab.new": ["Cmd+Alt+N"] }, win: { "tab.new": ["Ctrl+Alt+Y"] } });
    expect(parseKeybindings(text, "win").overrides.get("tab.new")).toEqual(["Ctrl+Alt+Y"]);
    expect(parseKeybindings(text, "mac").overrides.get("tab.new")).toEqual(["Alt+Cmd+N"]);
    expect(parseKeybindings(text, "linux").overrides.get("tab.new")).toEqual(["Ctrl+Alt+N"]);
  });

  it("an empty or broken file never throws", () => {
    expect(parseKeybindings("", "win")).toEqual({ overrides: new Map(), diagnostics: [] });
    const broken = parseKeybindings("{ nope", "win");
    expect(broken.overrides.size).toBe(0);
    expect(broken.diagnostics.map((d) => d.kind)).toEqual(["parse"]);
    expect(parseKeybindings("[1]", "win").diagnostics.map((d) => d.kind)).toEqual(["parse"]);
  });

  it("an unknown action is reported", () => {
    const { overrides, diagnostics } = parseKeybindings(file({ version: 1, keybindings: { "tab.fly": ["Ctrl+Y"] } }), "win");
    expect(overrides.size).toBe(0);
    expect(diagnostics).toEqual([expect.objectContaining({ kind: "unknownAction", action: "tab.fly" })]);
  });

  it("a bad chord is dropped; when none is left the defaults stay", () => {
    const { overrides, diagnostics } = parseKeybindings(
      file({ version: 1, keybindings: { "tab.new": ["Ctrl+Banana"], "tab.close": ["Ctrl+Banana", "Ctrl+Alt+Y"] } }),
      "win",
    );
    expect(overrides.has("tab.new")).toBe(false);
    expect(overrides.get("tab.close")).toEqual(["Ctrl+Alt+Y"]);
    expect(diagnostics.map((d) => [d.kind, d.action, d.chord])).toEqual([
      ["badChord", "tab.new", "Ctrl+Banana"],
      ["badChord", "tab.close", "Ctrl+Banana"],
    ]);
  });

  it("a value that is not a chord list is a bad chord", () => {
    const { overrides, diagnostics } = parseKeybindings(file({ version: 1, keybindings: { "tab.new": 5 } }), "win");
    expect(overrides.size).toBe(0);
    expect(diagnostics.map((d) => d.kind)).toEqual(["badChord"]);
  });

  it("an override on a default chord of the same scope: both kept, the default loses", () => {
    const { overrides, diagnostics } = parseKeybindings(file({ version: 1, keybindings: { "tab.new": ["Ctrl+W"] } }), "win");
    expect(overrides.get("tab.new")).toEqual(["Ctrl+W"]);
    expect(diagnostics).toEqual([expect.objectContaining({ kind: "conflict", action: "tab.new", chord: "Ctrl+W", with: ["tab.close"] })]);
    const merged = mergeBindings(overrides, "win");
    expect(merged.filter((b) => b.chord === "Ctrl+W")).toEqual([{ action: "tab.new", chord: "Ctrl+W", source: "user" }]);
    expect(merged.some((b) => b.action === "tab.close")).toBe(false);
  });

  it("two overrides on one chord: the later one in the file is dropped", () => {
    const { overrides, diagnostics } = parseKeybindings(
      file({ version: 1, keybindings: { "tab.new": ["Ctrl+Alt+N"], "tab.close": ["Ctrl+Alt+N", "Ctrl+Alt+Y"], "zoom.in": ["Ctrl+Alt+N"] } }),
      "win",
    );
    expect(overrides.get("tab.new")).toEqual(["Ctrl+Alt+N"]);
    expect(overrides.get("tab.close")).toEqual(["Ctrl+Alt+Y"]);
    expect(overrides.has("zoom.in")).toBe(false);
    expect(diagnostics.map((d) => [d.kind, d.action, d.with])).toEqual([
      ["conflict", "tab.close", ["tab.new"]],
      ["conflict", "zoom.in", ["tab.new"]],
    ]);
  });

  it("the same chord in another scope is no conflict", () => {
    const { diagnostics } = parseKeybindings(file({ version: 1, keybindings: { "terminal.find": ["Ctrl+Shift+E"] } }), "win");
    expect(diagnostics).toEqual([]);
  });

  it("a version other than 1 is reported but the keys still apply", () => {
    const { overrides, diagnostics } = parseKeybindings(file({ version: 2, keybindings: { "tab.new": ["Ctrl+Alt+N"] } }), "win");
    expect(overrides.get("tab.new")).toEqual(["Ctrl+Alt+N"]);
    expect(diagnostics.map((d) => d.kind)).toEqual(["parse"]);
  });
});

describe("mergeBindings", () => {
  it("defaults where there is no override, the override where there is, nothing for []", () => {
    const merged = mergeBindings(new Map<ActionId, string[]>([["tab.new", ["Ctrl+Alt+N"]], ["zoom.in", []]]), "win");
    expect(merged.filter((b) => b.action === "tab.new")).toEqual([{ action: "tab.new", chord: "Ctrl+Alt+N", source: "user" }]);
    expect(merged.filter((b) => b.action === "zoom.in")).toEqual([]);
    expect(merged.filter((b) => b.action === "tab.close")).toEqual([{ action: "tab.close", chord: "Ctrl+W", source: "default" }]);
  });
});

describe("serializeKeybindings", () => {
  it("writes only what differs from the defaults, sorted, two spaces", () => {
    const text = serializeKeybindings(
      new Map<ActionId, string[]>([["zoom.in", []], ["tab.new", ["Ctrl+Alt+N"]], ["tab.close", ["Ctrl+W"]]]),
      undefined,
      "win",
    );
    expect(text).toBe(`{\n  "version": 1,\n  "keybindings": {\n    "tab.new": [\n      "Ctrl+Alt+N"\n    ],\n    "zoom.in": []\n  }\n}\n`);
  });

  it("keeps an unknown key and the other platforms' sections", () => {
    const keep = file({ version: 1, keybindings: { "tab.fly": ["Ctrl+Y"], "tab.new": ["Ctrl+Alt+N"] }, mac: { "tab.new": ["Cmd+Alt+N"] }, note: "mine" });
    const out = JSON.parse(serializeKeybindings(new Map(), keep, "win"));
    expect(out).toEqual({ version: 1, keybindings: { "tab.fly": ["Ctrl+Y"] }, mac: { "tab.new": ["Cmd+Alt+N"] }, note: "mine" });
  });

  it("writes into this platform's section when the action lives there", () => {
    const keep = file({ version: 1, keybindings: { "tab.new": ["Ctrl+Alt+N"] }, win: { "tab.new": ["Ctrl+Alt+Y"] } });
    const out = JSON.parse(serializeKeybindings(new Map<ActionId, string[]>([["tab.new", ["Ctrl+Alt+Q"]]]), keep, "win"));
    expect(out).toEqual({ version: 1, keybindings: { "tab.new": ["Ctrl+Alt+N"] }, win: { "tab.new": ["Ctrl+Alt+Q"] } });
  });

  it("a reset in this platform's section writes the defaults when the shared one has the action", () => {
    const keep = file({ version: 1, keybindings: { "tab.new": ["Ctrl+Alt+N"] }, win: { "tab.new": ["Ctrl+Alt+Y"], "tab.close": ["Ctrl+Alt+Q"] } });
    const out = JSON.parse(serializeKeybindings(new Map(), keep, "win"));
    expect(out).toEqual({ version: 1, keybindings: { "tab.new": ["Ctrl+Alt+N"] }, win: { "tab.new": ["Ctrl+T"] } });
    expect(parseKeybindings(JSON.stringify(out), "win").overrides.get("tab.new")).toEqual(["Ctrl+T"]);
  });

  it("writes Cmd as Mod so the shared section reads on every platform", () => {
    const out = JSON.parse(serializeKeybindings(new Map<ActionId, string[]>([["tab.new", ["Cmd+Alt+N"]]]), undefined, "mac"));
    expect(out.keybindings).toEqual({ "tab.new": ["Mod+Alt+N"] });
  });

  it("round trips through the parser", () => {
    const keep = `{ // hand edited\n "version": 1, "keybindings": { "tab.fly": "x", }, "mac": { "zoom.in": [] } }`;
    const overrides = new Map<ActionId, string[]>([["tab.new", ["Ctrl+Alt+N"]], ["terminal.clear", []]]);
    const text = serializeKeybindings(overrides, keep, "win");
    expect(parseKeybindings(text, "win").overrides).toEqual(overrides);
    expect(JSON.parse(text).mac).toEqual({ "zoom.in": [] });
    expect(JSON.parse(text).keybindings["tab.fly"]).toBe("x");
  });
});

describe("conflicts", () => {
  const b = (action: ActionId, chord: string): EffectiveBinding => ({ action, chord, source: "user" });

  it("names the actions that share a chord in one scope", () => {
    expect(conflicts([b("tab.new", "Ctrl+W"), b("tab.close", "Ctrl+W"), b("zoom.in", "Ctrl+=")])).toEqual(new Map([["Ctrl+W", ["tab.new", "tab.close"]]]));
  });

  it("ignores one chord in different scopes", () => {
    expect(conflicts([b("docs.search", "Ctrl+K"), b("terminal.clear", "Ctrl+K"), b("search.open", "Ctrl+K")]).size).toBe(0);
  });

  it("is empty for the defaults", async () => {
    const { effectiveBindings } = await import("./keymap");
    expect(conflicts(effectiveBindings()).size).toBe(0);
  });
});
