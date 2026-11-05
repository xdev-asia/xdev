import { expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
import { ImageDiffView, type ViewProps } from "./ImageDiff";

const ready = (bytes: number) => ({ status: "ready" as const, url: "blob:x", bytes });
const base: ViewProps = {
  name: "logo.png",
  kind: "modified",
  before: ready(2048),
  after: ready(512),
  sizes: { old: { w: 20, h: 10 }, new: { w: 40, h: 30 } },
  mode: "side",
  swipe: 50,
  onion: 50,
  onMode() {},
  onSwipe() {},
  onOnion() {},
  onSize() {},
};
const html = (over: Partial<ViewProps> = {}) => renderToStaticMarkup(<ImageDiffView {...base} {...over} />);

it("side by side shows both images with their size and dimensions", () => {
  const out = html();
  expect(out).toContain('data-mode="side"');
  expect(out).toContain("logo.png, old version");
  expect(out).toContain("logo.png, new version");
  expect(out).toContain("20 × 10");
  expect(out).toContain("40 × 30");
  expect(out).toContain("2.0 KB");
  expect(out).toContain("512 B");
  expect(out).not.toContain('type="range"');
});

it("the mode buttons say which one is on", () => {
  const out = html({ mode: "swipe" });
  expect(out).toMatch(/<button[^>]*data-mode="swipe"[^>]*aria-pressed="true"/);
  expect(out).toMatch(/<button[^>]*data-mode="side"[^>]*aria-pressed="false"/);
  expect(out).toContain('aria-label="Image view"');
});

it("swipe clips the new image to the right of the handle and has a labelled slider", () => {
  const out = html({ mode: "swipe", swipe: 30 });
  expect(out).toContain("clip-path:inset(0 0 0 30%)");
  expect(out).toMatch(/<input[^>]*type="range"[^>]*min="0"[^>]*max="100"[^>]*value="30"/);
  expect(out).toContain("Swipe position");
  expect(out).toContain('aria-valuetext="30%"');
});

it("onion skin sets the opacity of the new image", () => {
  const out = html({ mode: "onion", onion: 25 });
  expect(out).toContain("opacity:0.25");
  expect(out).toContain("Opacity of the new image");
  expect(out).toContain('value="25"');
});

it("an added image shows one side with a label and no mode buttons", () => {
  const out = html({ kind: "added", before: { status: "none" } });
  expect(out).toContain("Added image");
  expect(out).toContain("logo.png, new version");
  expect(out).not.toContain("old version");
  expect(out).not.toContain("<button");
  const gone = html({ kind: "deleted", after: { status: "none" } });
  expect(gone).toContain("Deleted image");
  expect(gone).not.toContain("new version");
});

it("an old side that is not there reads as an added image even when the change says modified", () => {
  const out = html({ before: { status: "none" }, mode: "swipe" });
  expect(out).toContain('data-kind="added"');
  expect(out).not.toContain('type="range"');
});

it("says when it is loading, when an image is too large and when a read failed", () => {
  expect(html({ before: { status: "loading" } })).toContain('role="status"');
  expect(html({ before: { status: "too_large" } })).toContain("over 20 MB");
  expect(html({ after: { status: "error", code: "io" } })).toContain("could not be read");
});
