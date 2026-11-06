const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * The one change that turns `prev` into `next`: the common prefix and the common suffix (not
 * overlapping the prefix) stay; what is between them is replaced. Null when the texts are equal.
 * Offsets are UTF-16 units; a surrogate pair is never split.
 */
export function minimalChange(prev: string, next: string): { from: number; to: number; insert: string } | null {
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  // Do not stop between the halves of a pair.
  if (start > 0 && start < max + 1 && isHigh(prev.charCodeAt(start - 1))) start--;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  if (endPrev < prev.length && isLow(prev.charCodeAt(endPrev)) && endPrev > 0 && isHigh(prev.charCodeAt(endPrev - 1))) {
    endPrev++;
    endNext++;
  }
  return { from: start, to: endPrev, insert: next.slice(start, endNext) };
}
