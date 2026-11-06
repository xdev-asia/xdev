/** What a middle-click paste needs to decide. */
export type MiddlePasteInput = {
  enabled: boolean;
  platform: "win" | "mac" | "linux";
  button: number;
  /** xterm's mouse tracking: a program that asked for mouse events gets the click itself. */
  tracking: boolean;
  selection: string;
};

/** The text to paste for this click, or null when the click is not ours. Linux only. */
export function middlePasteText(input: MiddlePasteInput): string | null {
  if (!input.enabled || input.platform !== "linux" || input.button !== 1 || input.tracking) return null;
  return input.selection === "" ? null : input.selection;
}
