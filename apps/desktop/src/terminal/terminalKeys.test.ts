import { describe, expect, it } from "vitest";
import type { Platform } from "@/platform";
import {
  baseCharForCode,
  createOptionSideTracker,
  resolveTerminalKey,
  type KeyContext,
  type KeyLike,
} from "./terminalKeys";

const ctx = (platform: Platform, over: Partial<KeyContext> = {}): KeyContext => ({
  platform,
  optionAsAlt: "both",
  optionSide: 0,
  kittyFlags: 0,
  modifyOtherKeys: 0,
  alternateScreen: false,
  agent: true,
  jisYenToBackslash: false,
  ...over,
});
const key = (k: string, mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {}, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code: k,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  isComposing: false,
  keyCode: 0,
  ...extra,
});
const sent = (e: KeyLike, c: KeyContext) => {
  const a = resolveTerminalKey(e, c);
  return a?.type === "send" ? a.data : a;
};
const PLATFORMS: Platform[] = ["mac", "linux", "win"];

describe("Enter", () => {
  it("Shift+Enter: kitty, then modifyOtherKeys, then ESC CR", () => {
    for (const p of PLATFORMS) {
      const e = key("Enter", { shift: true });
      expect(sent(e, ctx(p))).toBe("\x1b\r");
      expect(sent(e, ctx(p, { modifyOtherKeys: 2 }))).toBe("\x1b[27;2;13~");
      expect(sent(e, ctx(p, { kittyFlags: 1, modifyOtherKeys: 2 }))).toBe("\x1b[13;2u");
    }
  });

  it("Alt+Enter is xterm's own unless modifyOtherKeys is on, and never under kitty", () => {
    for (const p of PLATFORMS) {
      const e = key("Enter", { alt: true });
      expect(sent(e, ctx(p))).toBeNull();
      expect(sent(e, ctx(p, { modifyOtherKeys: 1 }))).toBe("\x1b[27;3;13~");
      expect(sent(e, ctx(p, { kittyFlags: 1, modifyOtherKeys: 1 }))).toBeNull();
    }
  });

  it("Ctrl+Enter is a CSI u sequence only when the program asked for kitty or modifyOtherKeys", () => {
    const e = key("Enter", { ctrl: true });
    for (const p of PLATFORMS) {
      expect(sent(e, ctx(p))).toBeNull();
      expect(sent(e, ctx(p, { kittyFlags: 1 }))).toBe("\x1b[13;5u");
      expect(sent(e, ctx(p, { modifyOtherKeys: 2 }))).toBe("\x1b[27;5;13~");
    }
  });

  it("Shift+Enter in a plain shell is left to xterm, in an agent pane it is ESC CR", () => {
    const e = key("Enter", { shift: true });
    for (const p of PLATFORMS) {
      expect(sent(e, ctx(p, { agent: false }))).toBeNull();
      expect(sent(e, ctx(p, { agent: true }))).toBe("\x1b\r");
      expect(sent(e, ctx(p, { agent: false, kittyFlags: 1 }))).toBe("\x1b[13;2u");
    }
  });

  it("plain Enter and other combinations are left to xterm", () => {
    for (const p of PLATFORMS) {
      expect(sent(key("Enter"), ctx(p))).toBeNull();
      expect(sent(key("Enter", { shift: true, ctrl: true }), ctx(p))).toBeNull();
      expect(sent(key("Enter", { meta: true }), ctx(p))).toBeNull();
    }
  });
});

describe("Backspace and Delete", () => {
  it("Ctrl+Backspace deletes a word on macOS and Linux, Windows is left to xterm", () => {
    for (const p of ["mac", "linux"] as const) expect(sent(key("Backspace", { ctrl: true }), ctx(p))).toBe("\x17");
    expect(sent(key("Backspace", { ctrl: true }), ctx("win"))).toBeNull();
  });

  it("Cmd+Backspace and Cmd+Delete are macOS only", () => {
    expect(sent(key("Backspace", { meta: true }), ctx("mac"))).toBe("\x15");
    expect(sent(key("Delete", { meta: true }), ctx("mac"))).toBe("\x0b");
    for (const p of ["linux", "win"] as const) {
      expect(sent(key("Backspace", { meta: true }), ctx(p))).toBeNull();
      expect(sent(key("Delete", { meta: true }), ctx(p))).toBeNull();
    }
  });

  it("Alt+Backspace sends ESC DEL unless kitty is on", () => {
    for (const p of PLATFORMS) {
      expect(sent(key("Backspace", { alt: true }), ctx(p))).toBe("\x1b\x7f");
      expect(sent(key("Backspace", { alt: true }), ctx(p, { kittyFlags: 1 }))).toBeNull();
    }
  });

  it("Alt+Delete sends ESC d on macOS, not under kitty, not on Numpad, not in a full-screen non-agent app", () => {
    const e = key("Delete", { alt: true });
    expect(sent(e, ctx("mac"))).toBe("\x1bd");
    expect(sent(e, ctx("mac", { kittyFlags: 1 }))).toBeNull();
    expect(sent(key("Delete", { alt: true }, { code: "NumpadDecimal" }), ctx("mac"))).toBeNull();
    expect(sent(e, ctx("mac", { alternateScreen: true, agent: false }))).toBeNull();
    expect(sent(e, ctx("linux"))).toBeNull();
    expect(sent(e, ctx("win"))).toBeNull();
  });
});

describe("arrows", () => {
  it("Cmd+Left / Right go to the line ends on macOS only", () => {
    expect(sent(key("ArrowLeft", { meta: true }), ctx("mac"))).toBe("\x01");
    expect(sent(key("ArrowRight", { meta: true }), ctx("mac"))).toBe("\x05");
    expect(sent(key("ArrowLeft", { meta: true }), ctx("linux"))).toBeNull();
    expect(sent(key("ArrowRight", { meta: true }), ctx("win"))).toBeNull();
  });

  it("Cmd+Up / Down scroll and send nothing on macOS", () => {
    expect(resolveTerminalKey(key("ArrowUp", { meta: true }), ctx("mac"))).toEqual({ type: "scroll", to: "top" });
    expect(resolveTerminalKey(key("ArrowDown", { meta: true }), ctx("mac"))).toEqual({ type: "scroll", to: "bottom" });
    expect(resolveTerminalKey(key("ArrowUp", { meta: true }), ctx("linux"))).toBeNull();
  });

  it("Alt+Left / Right are word moves on macOS and Linux, left to xterm on Windows and under kitty", () => {
    for (const p of ["mac", "linux"] as const) {
      expect(sent(key("ArrowLeft", { alt: true }), ctx(p))).toBe("\x1bb");
      expect(sent(key("ArrowRight", { alt: true }), ctx(p))).toBe("\x1bf");
      expect(sent(key("ArrowLeft", { alt: true }), ctx(p, { kittyFlags: 1 }))).toBeNull();
    }
    expect(sent(key("ArrowLeft", { alt: true }), ctx("win"))).toBeNull();
    expect(sent(key("ArrowLeft", { alt: true }, { code: "Numpad4" }), ctx("linux"))).toBeNull();
  });

  it("Ctrl+Left / Right are word moves on Linux only", () => {
    expect(sent(key("ArrowLeft", { ctrl: true }), ctx("linux"))).toBe("\x1bb");
    expect(sent(key("ArrowRight", { ctrl: true }), ctx("linux"))).toBe("\x1bf");
    expect(sent(key("ArrowLeft", { ctrl: true }), ctx("win"))).toBeNull();
    expect(sent(key("ArrowLeft", { ctrl: true }), ctx("mac"))).toBeNull();
  });

  it("an extra modifier turns a rule off", () => {
    expect(sent(key("ArrowLeft", { alt: true, shift: true }), ctx("linux"))).toBeNull();
    expect(sent(key("ArrowLeft", { ctrl: true, shift: true }), ctx("linux"))).toBeNull();
    expect(sent(key("Backspace", { ctrl: true, alt: true }), ctx("linux"))).toBeNull();
  });
});

describe("IME", () => {
  it("is left alone while composing", () => {
    const c = ctx("linux");
    expect(sent(key("Enter", { shift: true }, { isComposing: true }), c)).toBeNull();
    expect(sent(key("Enter", { shift: true }, { keyCode: 229 }), c)).toBeNull();
  });
});

describe("Option as Alt (macOS)", () => {
  const opt = (code: string, shift = false, k = code) => key(k, { alt: true, shift }, { code });

  it("both: the resolver leaves Option keys to xterm", () => {
    expect(sent(opt("KeyB"), ctx("mac", { optionAsAlt: "both" }))).toBeNull();
    expect(sent(opt("KeyA"), ctx("mac", { optionAsAlt: "both" }))).toBeNull();
  });

  it("left / right: the owning side sends ESC + the base character", () => {
    const left = ctx("mac", { optionAsAlt: "left", optionSide: 1 });
    expect(sent(opt("KeyA"), left)).toBe("\x1ba");
    expect(sent(opt("Digit5"), left)).toBe("\x1b5");
    expect(sent(opt("Period"), left)).toBe("\x1b.");
    expect(sent(opt("Space"), left)).toBe("\x1b ");
    const right = ctx("mac", { optionAsAlt: "right", optionSide: 2 });
    expect(sent(opt("KeyA"), right)).toBe("\x1ba");
  });

  it("left / right: the other side composes, apart from the word keys", () => {
    const wrong = ctx("mac", { optionAsAlt: "left", optionSide: 2 });
    expect(sent(opt("KeyA"), wrong)).toBeNull();
    expect(sent(opt("Digit5"), wrong)).toBeNull();
    expect(sent(opt("KeyB"), wrong)).toBe("\x1bb");
    expect(sent(opt("KeyF"), wrong)).toBe("\x1bf");
    expect(sent(opt("KeyD"), wrong)).toBe("\x1bd");
  });

  it("Shift held: the owning side no longer sends", () => {
    const left = ctx("mac", { optionAsAlt: "left", optionSide: 1 });
    expect(sent(opt("KeyA", true), left)).toBeNull();
    expect(sent(opt("KeyB", true), left)).toBeNull();
  });

  it("off: no Option capture at all, Option+key and the Alt rewrites go to the system", () => {
    const off = ctx("mac", { optionAsAlt: "off" });
    for (const c of ["KeyB", "KeyF", "KeyD", "KeyE"]) expect(sent(opt(c), off)).toBeNull();
    expect(sent(key("ArrowLeft", { alt: true }), off)).toBeNull();
    expect(sent(key("Backspace", { alt: true }), off)).toBeNull();
    expect(sent(key("Delete", { alt: true }), off)).toBeNull();
  });

  it("left with the right side held: B, F and D still send, the rest composes", () => {
    const c = ctx("mac", { optionAsAlt: "left", optionSide: 2 });
    expect(sent(opt("KeyB"), c)).toBe("\x1bb");
    expect(sent(opt("KeyE"), c)).toBeNull();
  });

  it("a Dead key composes unless the configured side owns it", () => {
    const dead = key("Dead", { alt: true }, { code: "KeyE" });
    expect(sent(dead, ctx("mac", { optionAsAlt: "off" }))).toBeNull();
    expect(sent(dead, ctx("mac", { optionAsAlt: "both" }))).toBeNull();
    expect(sent(dead, ctx("mac", { optionAsAlt: "left", optionSide: 2 }))).toBeNull();
    expect(sent(dead, ctx("mac", { optionAsAlt: "left", optionSide: 1 }))).toBe("\x1be");
    expect(sent(key("Dead", { alt: true, shift: true }, { code: "KeyE" }), ctx("mac", { optionAsAlt: "left", optionSide: 1 }))).toBeNull();
  });

  it("does nothing off macOS", () => {
    expect(sent(opt("KeyB"), ctx("linux"))).toBeNull();
    expect(sent(opt("KeyB"), ctx("win"))).toBeNull();
  });
});

describe("baseCharForCode", () => {
  it("maps letters, digits and punctuation", () => {
    expect(baseCharForCode("KeyZ")).toBe("z");
    expect(baseCharForCode("Digit0")).toBe("0");
    for (const [code, ch] of Object.entries({
      Period: ".", Comma: ",", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'",
      BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`", Space: " ",
    })) expect(baseCharForCode(code)).toBe(ch);
  });

  it("has no character for other keys", () => {
    expect(baseCharForCode("Enter")).toBeUndefined();
    expect(baseCharForCode("Numpad1")).toBeUndefined();
    expect(baseCharForCode(undefined)).toBeUndefined();
  });
});

describe("option side tracker", () => {
  it("tracks each Option key by location and clears", () => {
    const t = createOptionSideTracker();
    expect(t.get()).toBe(0);
    t.down({ key: "Alt", location: 1 });
    expect(t.get()).toBe(1);
    t.down({ key: "Alt", location: 2 });
    expect(t.get()).toBe(3);
    t.up({ key: "Alt", location: 1 });
    expect(t.get()).toBe(2);
    t.clear();
    expect(t.get()).toBe(0);
  });

  it("ignores other keys and unknown locations", () => {
    const t = createOptionSideTracker();
    t.down({ key: "Shift", location: 1 });
    t.down({ key: "Alt", location: 0 });
    expect(t.get()).toBe(0);
  });
});

describe("plain shell versus agent and the alternate screen", () => {
  it("a plain shell on Linux and Windows keeps xterm's encoding for every rewrite", () => {
    for (const p of ["linux", "win"] as const) {
      const c = ctx(p, { agent: false });
      for (const e of [
        key("ArrowLeft", { alt: true }),
        key("ArrowRight", { ctrl: true }),
        key("Backspace", { alt: true }),
        key("Backspace", { ctrl: true }),
        key("Enter", { shift: true }),
      ])
        expect(sent(e, c)).toBeNull();
    }
  });

  it("macOS line editing and word moves apply in a shell on the main screen only", () => {
    const main = ctx("mac", { agent: false });
    const alt = ctx("mac", { agent: false, alternateScreen: true });
    expect(sent(key("ArrowLeft", { meta: true }), main)).toBe("\x01");
    expect(sent(key("ArrowLeft", { alt: true }), main)).toBe("\x1bb");
    for (const e of [key("ArrowLeft", { meta: true }), key("ArrowLeft", { alt: true }), key("Backspace", { meta: true }), key("ArrowUp", { meta: true })])
      expect(resolveTerminalKey(e, alt)).toBeNull();
  });

  it("an agent keeps the rewrites on the alternate screen", () => {
    const c = ctx("linux", { agent: true, alternateScreen: true });
    expect(sent(key("ArrowLeft", { alt: true }), c)).toBe("\x1bb");
    expect(sent(key("Enter", { shift: true }), c)).toBe("\x1b\r");
  });
});

describe("JIS Yen", () => {
  const yen = "¥";
  it("sends a backslash on mac when on", () => {
    expect(resolveTerminalKey(key(yen), ctx("mac", { jisYenToBackslash: true }))).toEqual({ type: "send", data: "\\" });
  });
  it("leaves the key alone when off or off mac", () => {
    expect(resolveTerminalKey(key(yen), ctx("mac"))).toBeNull();
    expect(resolveTerminalKey(key(yen), ctx("win", { jisYenToBackslash: true }))).toBeNull();
  });
  it("does not apply with meta", () => {
    expect(resolveTerminalKey(key(yen, { meta: true }), ctx("mac", { jisYenToBackslash: true }))).not.toEqual({ type: "send", data: "\\" });
  });
});
