export type PasteResult = "text" | "image" | "empty" | "too_large" | "failed";

export async function pasteClipboard(_deps: {
  readText(): Promise<string>;
  saveImage(): Promise<string | null>;
  pasteText(text: string): void | Promise<void>;
  writeRaw(data: string): Promise<void>;
}): Promise<PasteResult> {
  throw new Error("not implemented");
}
