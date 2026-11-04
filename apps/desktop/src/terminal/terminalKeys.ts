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

export function resolveTerminalKey(_e: KeyLike, _ctx: KeyContext): KeyAction | null {
  throw new Error("not implemented");
}

export function baseCharForCode(_code: string | undefined): string | undefined {
  throw new Error("not implemented");
}

export function createOptionSideTracker(): {
  down(e: { key: string; location: number }): void;
  up(e: { key: string; location: number }): void;
  clear(): void;
  get(): 0 | 1 | 2 | 3;
} {
  throw new Error("not implemented");
}
