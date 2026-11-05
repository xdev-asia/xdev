import type { ReviewAiHunk, ReviewAiPlan, ReviewFinding, WorktreeChange } from "./api";

// A 2x2 PNG: the old side of a changed image; `fileBytes` of the mock serves a 1x1 for the new side.
const TWO = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM4YWNjs8CGAUIBACJuBLEqVvWlAAAAAElFTkSuQmCC";

const bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** The bytes the mock serves for an image's old side. */
export function mockImageBytes(): Uint8Array {
  return bytes(TWO);
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

/** One two-line hunk per changed text file; an image is skipped as binary, a deletion as deleted. */
export function mockReviewPlan(changes: WorktreeChange[]): ReviewAiPlan {
  const hunks: ReviewAiHunk[] = [];
  const skipped: ReviewAiPlan["skipped"] = [];
  for (const c of changes) {
    if (c.kind === "deleted") skipped.push({ file: c.path, reason: "deleted" });
    else if (IMAGE.test(c.path)) skipped.push({ file: c.path, reason: "binary" });
    else hunks.push({ file: c.path, newStart: 1, newLines: 2, text: `@@ -1,2 +1,2 @@\n    1  // ${c.path}\n    2 +export const value = 2;\n` });
  }
  const hash = [...hunks.map((h) => h.file + h.text), ...skipped.map((s) => s.file + s.reason)].join("|");
  let n = 0;
  for (const ch of hash) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return { diffHash: n.toString(16).padStart(8, "0"), hunks, skipped };
}

/** One finding per hunk, on its second line. */
export function mockReviewFindings(hunk: ReviewAiHunk): ReviewFinding[] {
  return [{ severity: "warning", line: hunk.newStart + 1, text: `Check that ${hunk.file} still handles the old value.` }];
}
