import { expect, it } from "vitest";
import { docsShown } from "./docsShown";

const doc = (host: { hasAttribute(name: string): boolean } | null) => ({ querySelector: () => host }) as unknown as Document;

it("is true when the docs app stands alone", () => expect(docsShown(doc(null))).toBe(true));
it("is true while the docs view is shown", () => expect(docsShown(doc({ hasAttribute: () => false }))).toBe(true));
it("is false while the workspace hides the docs view, so Ctrl+N does not create a doc", () => {
  expect(docsShown(doc({ hasAttribute: (n) => n === "hidden" }))).toBe(false);
});
it("is true without a document", () => expect(docsShown(undefined)).toBe(true));
