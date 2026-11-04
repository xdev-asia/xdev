import { expect, it } from "vitest";
import { failedLinks } from "./linkReport";

it("lists only the paths that did not link, with the reason", () => {
  expect(failedLinks([])).toEqual([]);
  expect(failedLinks([{ path: "node_modules", ok: true, error: null }])).toEqual([]);
  expect(
    failedLinks([
      { path: "node_modules", ok: true, error: null },
      { path: ".env.local", ok: false, error: "missing in the main checkout" },
      { path: "target", ok: false, error: null },
    ]),
  ).toEqual([".env.local: missing in the main checkout", "target"]);
});
