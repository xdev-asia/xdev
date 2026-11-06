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

it("maps every glyph per CLI", () => {
  for (const g of ["⠀", "⠋", "⣿"]) expect(titleStatus("claude", `${g} Task`), g).toBe("working");
  for (const g of ["✢", "✶", "✻", "✽"]) expect(titleStatus("claude", `${g} Task`), g).toBe("working");
  expect(titleStatus("claude", "✳ Task")).toBe("idle");
  expect(titleStatus("gemini", "✦ Ready")).toBe("working");
  expect(titleStatus("gemini", "◇ Ready")).toBe("idle");
  expect(titleStatus("gemini", "✋ Action required")).toBe("needs-you");
  expect(titleStatus("gemini", "⠋ x")).toBeNull();
  expect(titleStatus("gemini", "plain")).toBeNull();
  expect(titleStatus("codex", "✦ x")).toBeNull();
});

it("gemini_working_without_output_is_working", () => {
  expect(titleStatus("gemini", "⏲  Working… (repo)")).toBe("working");
  expect(titleStatus("claude", "⏲  Working…")).toBeNull();
});

it("codex_action_required_needs_you_in_both_frames_even_with_a_spinner_after", () => {
  expect(titleStatus("codex", "[ ! ] Action Required | repo")).toBe("needs-you");
  expect(titleStatus("codex", "[ . ] Action Required | ◐ repo")).toBe("needs-you");
  expect(titleStatus("codex", "repo | [ ! ] Action Required")).toBeNull();
  expect(titleStatus("gemini", "[ ! ] Action Required")).toBeNull();
});

it("a spinner glyph counts only at the start of a Braille title", () => {
  expect(titleStatus("claude", "Task ⠋")).toBeNull();
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
