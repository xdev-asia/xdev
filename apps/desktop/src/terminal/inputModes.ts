import type { Terminal as XTerm } from "@xterm/xterm";

/** What the program asked for, per xterm buffer. */
export interface InputModes {
  /** Kitty keyboard flags of the active screen. */
  kittyFlags(): number;
  /** The modifyOtherKeys level the program set. */
  modifyOtherKeys(): number;
  dispose(): void;
}

export function trackInputModes(_term: Pick<XTerm, "parser" | "buffer">): InputModes {
  throw new Error("not implemented");
}
