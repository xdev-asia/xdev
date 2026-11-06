import { bracketed, isImagePath, quotePath, type ShellKind } from "./pathPaste";

export type PasteResult = "text" | "image" | "empty" | "discarded" | "too_large" | "failed";

export interface ImagePathDeps {
  writeRaw(data: string): Promise<void>;
  /** The quoting kind of the running program. */
  shell(): ShellKind;
  /** Whether the program turned bracketed paste mode (2004) on. */
  bracketedMode(): boolean;
}

/** Writes an image path as one quoted word: bracketed when asked for, else plain with a trailing space. False when the path cannot be quoted safely. */
export async function writeImagePath(deps: ImagePathDeps, path: string): Promise<boolean> {
  const word = quotePath(path, deps.shell());
  if (word === null) return false;
  await deps.writeRaw(deps.bracketedMode() ? bracketed(word) : `${word} `);
  return true;
}

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
  /** Opens a pasted image for notes first (the setting `capture.annotatePaste`): the path to write, or null to write nothing. Absent: the image goes in as it is. */
  annotate?(path: string): Promise<string | null>;
}): Promise<PasteResult> {
  const text = await deps.readText().catch(() => "");
  if (text) {
    await deps.pasteText(text);
    return "text";
  }
  try {
    const path = await deps.saveImage();
    if (path === null) return "empty";
    const final = deps.annotate && isImagePath(path) ? await deps.annotate(path) : path;
    if (final === null) return "discarded";
    return (await writeImagePath(deps, final)) ? "image" : "failed";
  } catch (e) {
    return (e as { code?: string } | null)?.code === "too_large" ? "too_large" : "failed";
  }
}
