import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusGlyph } from "./StatusGlyph";

it("draws one glyph per status and nothing for a plain shell", () => {
  expect(StatusGlyph({ status: null, label: "" })).toBeNull();
  const html = (status: Parameters<typeof StatusGlyph>[0]["status"]) => renderToStaticMarkup(StatusGlyph({ status, label: "L" })!);
  expect(html("needs-you")).toBe('<span class="ws-glyph" data-status="needs-you" role="img" aria-label="L" title="L">?</span>');
  expect(html("done")).toContain(">✓</span>");
  // The spinner, dots and ring are CSS shapes with no text.
  for (const status of ["working", "failed", "idle", "exited"] as const) {
    expect(html(status)).toBe(`<span class="ws-glyph" data-status="${status}" role="img" aria-label="L" title="L"></span>`);
  }
});
