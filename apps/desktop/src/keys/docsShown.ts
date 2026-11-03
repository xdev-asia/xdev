/**
 * False while the workspace shell keeps the docs app mounted but hidden (`.ws-docs[hidden]`), so a
 * docs-only key does nothing there. True when the docs app is on screen or stands alone.
 */
export function docsShown(doc: Pick<Document, "querySelector"> | undefined = typeof document === "undefined" ? undefined : document): boolean {
  const host = doc?.querySelector(".ws-docs");
  return !host?.hasAttribute("hidden");
}
