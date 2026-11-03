import { expect, it } from "vitest";
import { TITLE_RULES, titleStatus, type TitleRule } from "./titles";

it("title rules map recorded titles", () => {
  // No title was recorded from a real launch yet, so nothing matches by default.
  expect(TITLE_RULES).toEqual([]);
  expect(titleStatus("claude", "anything")).toBeNull();
  // The matching itself, with rules given here.
  const rules: TitleRule[] = [
    { cli: "claude", match: /^working/, status: "working" },
    { cli: "codex", match: /waiting$/, status: "needs-you" },
  ];
  expect(titleStatus("claude", "working on it", rules)).toBe("working");
  expect(titleStatus("codex", "working on it", rules)).toBeNull();
  expect(titleStatus("codex", "still waiting", rules)).toBe("needs-you");
  // An unknown title, or a tab with no known CLI, says nothing.
  expect(titleStatus("claude", "vim main.rs", rules)).toBeNull();
  expect(titleStatus(null, "working", rules)).toBeNull();
});
