import { bracketed, quotePath, type ShellKind } from "./pathPaste";

export type PasteResult = "text" | "image" | "empty" | "too_large" | "failed";

/**
 * Paste what the clipboard holds: text through the terminal's own paste, else an image saved as a
 * PNG whose path goes in as one quoted word: bracketed when the program asked for bracketed paste
 * (an agent CLI reads that as an attachment), else plain with a trailing space.
 */
export async function pasteClipboard(deps: {
  readText(): Promise<string>;
  saveImage(): Promise<string | null>;
  pasteText(text: string): void | Promise<void>;
  writeRaw(data: string): Promise<void>;
  /** The quoting kind of the running program. */
  shell(): ShellKind;
  /** Whether the program turned bracketed paste mode (2004) on. */
  bracketedMode(): boolean;
}): Promise<PasteResult> {
  const text = await deps.readText().catch(() => "");
  if (text) {
    await deps.pasteText(text);
    return "text";
  }
  try {
    const path = await deps.saveImage();
    if (path === null) return "empty";
    const word = quotePath(path, deps.shell());
    if (word === null) return "failed";
    await deps.writeRaw(deps.bracketedMode() ? bracketed(word) : `${word} `);
    return "image";
  } catch (e) {
    return (e as { code?: string } | null)?.code === "too_large" ? "too_large" : "failed";
  }
}
