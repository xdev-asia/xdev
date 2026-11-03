import { expect, it } from "vitest";
import { checkName } from "./nameCheck";

it("names the first problem, or null for a good name", () => {
  expect(checkName("", [])).toBe("empty");
  expect(checkName("  ", [])).toBe("empty");
  expect(checkName("a/b", [])).toBe("slash");
  expect(checkName("a\\b", [])).toBe("slash");
  expect(checkName(".git", [])).toBe("git");
  expect(checkName("a.", [])).toBe("trailing");
  expect(checkName("a ", [])).toBe("trailing");
  expect(checkName("nul", [])).toBe("reserved");
  expect(checkName("COM1.txt", [])).toBe("reserved");
  expect(checkName("console.ts", [])).toBeNull();
  expect(checkName("Main.rs", ["main.rs"])).toBe("exists");
  expect(checkName(".gitignore", ["a"])).toBeNull();
});
