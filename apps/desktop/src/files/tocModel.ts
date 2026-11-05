import type { Heading } from "@/doc/markdownRich";

/** The deepest heading level the table of contents lists. */
export const TOC_DEPTH = 3;

/** The headings the table of contents lists: h1 to h3. */
export function tocOf(headings: readonly Heading[]): Heading[] {
  return headings.filter((h) => h.level <= TOC_DEPTH);
}

/** Scrolls to the element of `root` whose id is `id`; scoped to `root` since two previews can be open at once. */
export function scrollToHeading(root: { querySelector(selector: string): { scrollIntoView(arg?: unknown): void } | null }, id: string): boolean {
  const el = root.querySelector(`[id="${id.replace(/["\\]/g, "\\$&")}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "start" });
  return true;
}
