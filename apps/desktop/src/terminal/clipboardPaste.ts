import { bracketed } from "./pathPaste";

export type PasteResult = "text" | "image" | "empty" | "too_large" | "failed";

/**
 * Paste what the clipboard holds: text through the terminal's own paste, else an image saved as a
 * PNG whose path goes in as a bracketed paste (an agent CLI reads it as an attachment).
 */
export async function pasteClipboard(deps: {
  readText(): Promise<string>;
  saveImage(): Promise<string | null>;
  pasteText(text: string): void | Promise<void>;
  writeRaw(data: string): Promise<void>;
}): Promise<PasteResult> {
  const text = await deps.readText().catch(() => "");
  if (text) {
    await deps.pasteText(text);
    return "text";
  }
  try {
    const path = await deps.saveImage();
    if (path === null) return "empty";
    await deps.writeRaw(bracketed(path));
    return "image";
  } catch (e) {
    return (e as { code?: string } | null)?.code === "too_large" ? "too_large" : "failed";
  }
}
