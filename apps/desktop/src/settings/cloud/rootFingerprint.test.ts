import { expect, it } from "vitest";
import { decodeRoot, rootFingerprint } from "./rootFingerprint";

const ZEROS = "A".repeat(43);

it("matches the license crate's fingerprint of 32 zero bytes", () => {
  expect(rootFingerprint(ZEROS)).toBe("MZUH-VLPY-MK6X-O3EP");
});

it("refuses text that is not a 32-byte key", () => {
  expect(rootFingerprint("")).toBeNull();
  expect(rootFingerprint("not a key")).toBeNull();
  expect(rootFingerprint("AAAA")).toBeNull();
  expect(decodeRoot(ZEROS)?.length).toBe(32);
});

it("differs for another key", () => {
  expect(rootFingerprint("B".repeat(43))).not.toBe(rootFingerprint(ZEROS));
});
