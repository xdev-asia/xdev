import type { Platform } from "@/platform";

export type KeyLike = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode"
>;

export type KeyContext = {
  platform: Platform;
  /** The effective Option-as-Alt value. */
  optionAsAlt: "both" | "left" | "right" | "off";
  /** Held Option keys: bit 1 left, bit 2 right. */
  optionSide: 0 | 1 | 2 | 3;
  kittyFlags: number;
  modifyOtherKeys: number;
  fullScreenNonAgent: boolean;
};

export type KeyAction = { type: "send"; data: string } | { type: "scroll"; to: "top" | "bottom" };

const ESC = "\x1b";
const send = (data: string): KeyAction => ({ type: "send", data });

const PUNCTUATION: Record<string, string> = {
  Period: ".",
  Comma: ",",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: " ",
};

/** The character a physical key types with no modifier on a US layout; undefined for other keys. */
export function baseCharForCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return PUNCTUATION[code];
}

/** Which Option keys are held, from the `Alt` key's keydown / keyup `location`. */
export function createOptionSideTracker(): {
  down(e: { key: string; location: number }): void;
  up(e: { key: string; location: number }): void;
  clear(): void;
  get(): 0 | 1 | 2 | 3;
} {
  let bits = 0;
  const bit = (e: { key: string; location: number }) => (e.key !== "Alt" ? 0 : e.location === 1 ? 1 : e.location === 2 ? 2 : 0);
  return {
    down: (e) => void (bits |= bit(e)),
    up: (e) => void (bits &= ~bit(e)),
    clear: () => void (bits = 0),
    get: () => bits as 0 | 1 | 2 | 3,
  };
}

/** What Option does to a key the shortcut table does not cover (macOS, Option held, no Cmd / Ctrl). */
function optionKey(e: KeyLike, ctx: KeyContext): KeyAction | null {
  const owns =
    !e.shiftKey &&
    ((ctx.optionAsAlt === "left" && (ctx.optionSide & 1) !== 0) ||
      (ctx.optionAsAlt === "right" && (ctx.optionSide & 2) !== 0));
  if (e.key === "Dead") {
    const base = owns ? baseCharForCode(e.code) : undefined;
    return base === undefined ? null : send(ESC + base);
  }
  if (ctx.optionAsAlt === "both") return null;
  if (owns) {
    const base = baseCharForCode(e.code);
    if (base !== undefined) return send(ESC + base);
  }
  // `off`, and the side that is not Meta: word moves still work, everything else composes.
  if (!e.shiftKey) {
    if (e.code === "KeyB") return send(`${ESC}b`);
    if (e.code === "KeyF") return send(`${ESC}f`);
    if (e.code === "KeyD") return send(`${ESC}d`);
  }
  return null;
}

/**
 * Bytes (or a scroll) for a keydown xterm 6.0.0 would not encode the way agent TUIs and shells
 * expect; null leaves the key to xterm. App shortcuts are checked before this.
 */
export function resolveTerminalKey(e: KeyLike, ctx: KeyContext): KeyAction | null {
  if (e.isComposing || e.keyCode === 229) return null;
  const { platform, kittyFlags: kitty, modifyOtherKeys: mok } = ctx;
  const mac = platform === "mac";
  const win = platform === "win";
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = e;
  const only = (m: "meta" | "ctrl" | "alt" | "shift") =>
    meta === (m === "meta") && ctrl === (m === "ctrl") && alt === (m === "alt") && shift === (m === "shift");
  const numpad = e.code?.startsWith("Numpad") ?? false;

  switch (e.key) {
    case "Enter":
      if (only("shift")) return send(kitty > 0 ? `${ESC}[13;2u` : mok > 0 ? `${ESC}[27;2;13~` : `${ESC}\r`);
      if (only("alt") && kitty === 0) return mok > 0 ? send(`${ESC}[27;3;13~`) : null;
      if (only("ctrl")) return send(win && kitty === 0 ? "\r" : `${ESC}[13;5u`);
      return null;
    case "Backspace":
      if (only("ctrl")) return send("\x17");
      if (only("meta") && mac) return send("\x15");
      if (only("alt")) return kitty > 0 ? null : send(`${ESC}\x7f`);
      return null;
    case "Delete":
      if (only("meta") && mac) return send("\x0b");
      if (only("alt") && mac && !numpad && !ctx.fullScreenNonAgent) return kitty > 0 ? null : send(`${ESC}d`);
      break;
    case "ArrowLeft":
    case "ArrowRight": {
      const left = e.key === "ArrowLeft";
      if (only("meta") && mac) return send(left ? "\x01" : "\x05");
      if (only("alt") && !numpad) return kitty > 0 || win ? null : send(left ? `${ESC}b` : `${ESC}f`);
      if (only("ctrl") && !mac) return win ? null : send(left ? `${ESC}b` : `${ESC}f`);
      return null;
    }
    case "ArrowUp":
    case "ArrowDown":
      if (only("meta") && mac) return { type: "scroll", to: e.key === "ArrowUp" ? "top" : "bottom" };
      return null;
  }

  if (mac && alt && !ctrl && !meta) return optionKey(e, ctx);
  return null;
}
