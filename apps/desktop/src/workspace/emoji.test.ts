import { expect, it } from "vitest";
import { EMOJI, expandShortcodes, slugFromTitle } from "./emoji";

it("holds exactly the 40 listed codes", () => {
  expect(Object.keys(EMOJI)).toHaveLength(40);
});

it("expands known shortcodes only", () => {
  expect(expandShortcodes(":rocket: login :nope:")).toBe("🚀 login :nope:");
  expect(expandShortcodes(":toString: :constructor:")).toBe(":toString: :constructor:");
});

it("slug uses the code word", () => {
  expect(slugFromTitle("🚀 login")).toBe("rocket-login");
  expect(slugFromTitle("✨ New UI!")).toBe("sparkles-new-ui");
  expect(slugFromTitle("⚠️ careful")).toBe("warning-careful");
  expect(slugFromTitle("plain name")).toBe("plain-name");
});
