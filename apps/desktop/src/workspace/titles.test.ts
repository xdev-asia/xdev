import { expect, it } from "vitest";
import { TITLE_RULES, titleStatus, type TitleRule } from "./titles";

it("title rules map glyphs to a status per CLI", () => {
  expect(TITLE_RULES.length).toBeGreaterThan(0);
  expect(titleStatus("claude", "⠋ Fixing")).toBe("working");
  expect(titleStatus("codex", "⠋ Fixing")).toBe("working");
  expect(titleStatus("codex", "◐ x")).toBe("working");
  expect(titleStatus("claude", "✳ Claude")).toBe("idle");
  expect(titleStatus("codex", "✳ Claude")).toBeNull();
  expect(titleStatus("claude", "plain title")).toBeNull();
  expect(titleStatus(null, "⠋ x")).toBeNull();
});

it("matching uses the rules given", () => {
  const rules: TitleRule[] = [
    { cli: "claude", match: /^working/, status: "working" },
    { cli: "codex", match: /waiting$/, status: "needs-you" },
  ];
  expect(titleStatus("claude", "working on it", rules)).toBe("working");
  expect(titleStatus("codex", "working on it", rules)).toBeNull();
  expect(titleStatus("codex", "still waiting", rules)).toBe("needs-you");
  expect(titleStatus("claude", "vim main.rs", rules)).toBeNull();
});
