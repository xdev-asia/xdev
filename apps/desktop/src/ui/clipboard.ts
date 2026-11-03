/** Writes text to the system clipboard (the writer copy-on-select uses); false when the webview refuses. */
export async function copyText(text: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
