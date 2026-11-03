import { eventChord } from "@/keys/keymap";
import { PLATFORM } from "@/platform";

export type RecorderStep =
  | { kind: "ignore" }
  | { kind: "cancel" }
  | { kind: "clear" }
  | { kind: "invalid" }
  | { kind: "chord"; chord: string };

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"]);

/** What a key pressed while the recorder listens means. Escape cancels, Backspace clears. */
export function recorderStep(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing">): RecorderStep {
  if (e.isComposing || MODIFIER_KEYS.has(e.key)) return { kind: "ignore" };
  const bare = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
  if (bare && e.key === "Escape") return { kind: "cancel" };
  if (bare && e.key === "Backspace") return { kind: "clear" };
  const chord = eventChord(e as KeyboardEvent, PLATFORM);
  return chord === null ? { kind: "invalid" } : { kind: "chord", chord };
}
