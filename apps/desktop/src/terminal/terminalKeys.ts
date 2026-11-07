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
  /** The program is on the alternate screen (vim, less, tmux, a TUI). */
  alternateScreen: boolean;
  /** The pane runs an agent CLI rather than a plain shell or tool. */
  agent: boolean;
  /** macOS, JIS keyboard: the Yen key types a backslash. */
  jisYenToBackslash: boolean;
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
function optionKey(e: KeyLike, ctx: KeyContext, feel: boolean): KeyAction | null {
  // `off` and `both` leave Option to the system (`off`) or to xterm (`both`).
  if (ctx.optionAsAlt === "off" || ctx.optionAsAlt === "both") return null;
  const owns =
    !e.shiftKey &&
    ((ctx.optionAsAlt === "left" && (ctx.optionSide & 1) !== 0) ||
      (ctx.optionAsAlt === "right" && (ctx.optionSide & 2) !== 0));
  if (e.key === "Dead") {
    const base = owns ? baseCharForCode(e.code) : undefined;
    return base === undefined ? null : send(ESC + base);
  }
  if (owns) {
    const base = baseCharForCode(e.code);
    if (base !== undefined) return send(ESC + base);
  }
  // The side that is not Meta: word moves still work, everything else composes.
  if (feel && !e.shiftKey) {
    if (e.code === "KeyB") return send(`${ESC}b`);
    if (e.code === "KeyF") return send(`${ESC}f`);
    if (e.code === "KeyD") return send(`${ESC}d`);
  }
  return null;
}

/**
 * Bytes (or a scroll) for a keydown xterm 6.0.0 would not encode the way agent TUIs and shells
 * expect; null leaves the key to xterm. App shortcuts are checked before this.
 *
 * A plain shell keeps xterm's encoding unless the program turned on kitty flags or
 * modifyOtherKeys; the macOS line editing keys and word moves apply on macOS, and agent panes get
 * them everywhere. Nothing is rewritten on the alternate screen of a program that is not an agent.
 */
export function resolveTerminalKey(e: KeyLike, ctx: KeyContext): KeyAction | null {
  if (e.isComposing || e.keyCode === 229) return null;
  const { platform, kittyFlags: kitty, modifyOtherKeys: mok, agent } = ctx;
  const mac = platform === "mac";
  const win = platform === "win";
  // Rewrites that are not an opt-in of the program: macOS and agent panes only, never in a full-screen tool.
  const feel = (agent || mac) && (agent || !ctx.alternateScreen);
  // With Option as Alt off, Option is left to the system on macOS: no Option rule applies.
  const altOk = !(mac && ctx.optionAsAlt === "off");
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = e;
  const only = (m: "meta" | "ctrl" | "alt" | "shift") =>
    meta === (m === "meta") && ctrl === (m === "ctrl") && alt === (m === "alt") && shift === (m === "shift");
  const numpad = e.code?.startsWith("Numpad") ?? false;

  // A JIS keyboard's Yen key sends a backslash when Settings says so; Option keeps its own rules.
  if (mac && ctx.jisYenToBackslash && e.key === "¥" && !meta && !ctrl && !alt) return send("\\");

  switch (e.key) {
    case "Enter":
      if (only("shift")) {
        if (kitty > 0) return send(`${ESC}[13;2u`);
        if (mok > 0) return send(`${ESC}[27;2;13~`);
        // Only an agent CLI reads ESC CR as a new line; in a shell ESC leaves vi mode and CR runs the line.
        return agent ? send(`${ESC}\r`) : null;
      }
      if (only("alt") && kitty === 0) return mok > 0 ? send(`${ESC}[27;3;13~`) : null;
      if (only("ctrl")) return kitty > 0 ? send(`${ESC}[13;5u`) : mok > 0 ? send(`${ESC}[27;5;13~`) : null;
      return null;
    case "Backspace":
      if (only("ctrl")) return feel && !win ? send("\x17") : null;
      if (only("meta") && mac) return feel ? send("\x15") : null;
      if (only("alt")) return kitty > 0 || !feel || !altOk ? null : send(`${ESC}\x7f`);
      return null;
    case "Delete":
      if (only("meta") && mac) return feel ? send("\x0b") : null;
      if (only("alt") && mac && !numpad && feel && altOk) return kitty > 0 ? null : send(`${ESC}d`);
      break;
    case "ArrowLeft":
    case "ArrowRight": {
      const left = e.key === "ArrowLeft";
      if (only("meta") && mac) return feel ? send(left ? "\x01" : "\x05") : null;
      if (only("alt") && !numpad) return kitty > 0 || win || !feel || !altOk ? null : send(left ? `${ESC}b` : `${ESC}f`);
      if (only("ctrl") && !mac) return win || kitty > 0 || !feel ? null : send(left ? `${ESC}b` : `${ESC}f`);
      return null;
    }
    case "ArrowUp":
    case "ArrowDown":
      if (only("meta") && mac && feel) return { type: "scroll", to: e.key === "ArrowUp" ? "top" : "bottom" };
      return null;
  }

  if (mac && alt && !ctrl && !meta) return optionKey(e, ctx, feel);
  return null;
}
