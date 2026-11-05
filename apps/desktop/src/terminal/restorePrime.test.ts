import { expect, it } from "vitest";
import { noteBytes, setPrime, takePrime } from "./restorePrime";

it("take is once", () => {
  setPrime("a", { bytes: new Uint8Array([1]), note: "n" });
  expect(takePrime("a")).toEqual({ bytes: new Uint8Array([1]), note: "n" });
  expect(takePrime("a")).toBeNull();
  expect(takePrime("never")).toBeNull();
});

it("the note is dim and ends its line", () => {
  expect(new TextDecoder().decode(noteBytes("hi"))).toBe("\x1b[0m\x1b[2mhi\x1b[0m\r\n");
});
