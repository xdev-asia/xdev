import { expect, it } from "vitest";
import { effectiveKind, isImagePath, modesFor, onionOpacity, swipeClip } from "./imageDiffModel";

it("knows the image formats the review draws as images", () => {
  for (const f of ["a.png", "b/c.JPG", "d.jpeg", "e.gif", "f.webp", "g.svg", "h.bmp", "i.ico"]) expect(isImagePath(f), f).toBe(true);
  for (const f of ["a.ts", "png", "a.png.txt", "a.pdf", "a.avif"]) expect(isImagePath(f), f).toBe(false);
});

it("a modified image offers three views, an added or deleted one only the side view", () => {
  expect(modesFor("modified")).toEqual(["side", "swipe", "onion"]);
  expect(modesFor("added")).toEqual(["side"]);
  expect(modesFor("deleted")).toEqual(["side"]);
});

it("the swipe clip and the onion opacity stay in range", () => {
  expect(swipeClip(50)).toBe("inset(0 0 0 50%)");
  expect(swipeClip(-5)).toBe("inset(0 0 0 0%)");
  expect(swipeClip(140)).toBe("inset(0 0 0 100%)");
  expect(onionOpacity(25)).toBe(0.25);
  expect(onionOpacity(300)).toBe(1);
  expect(onionOpacity(-1)).toBe(0);
});

it("a side that is not there turns the change into an added or deleted one", () => {
  expect(effectiveKind("modified", true, false)).toBe("added");
  expect(effectiveKind("modified", false, true)).toBe("deleted");
  expect(effectiveKind("modified", false, false)).toBe("modified");
  expect(effectiveKind("added", false, false)).toBe("added");
});
