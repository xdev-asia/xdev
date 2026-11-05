import type { ReviewFile } from "@/api";

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

/** True for a file the review shows as images rather than as a text diff. */
export const isImagePath = (path: string): boolean => IMAGE.test(path);

export type ImageMode = "side" | "swipe" | "onion";

/** The modes a change offers: an added or deleted image has only one side, so only the side view. */
export function modesFor(kind: ReviewFile["kind"]): ImageMode[] {
  return kind === "modified" ? ["side", "swipe", "onion"] : ["side"];
}

/** The part of the new image a swipe at `pos` percent leaves visible: everything right of the handle. */
export function swipeClip(pos: number): string {
  const at = Math.min(100, Math.max(0, Math.round(pos)));
  return `inset(0 0 0 ${at}%)`;
}

/** Opacity of the new image for a slider at `pos` percent. */
export const onionOpacity = (pos: number): number => Math.min(100, Math.max(0, pos)) / 100;

/** The same change read as it is now: an old side that is missing makes the image an added one. */
export function effectiveKind(kind: ReviewFile["kind"], oldMissing: boolean, newMissing: boolean): ReviewFile["kind"] {
  if (oldMissing && !newMissing) return "added";
  if (newMissing && !oldMissing) return "deleted";
  return kind;
}
