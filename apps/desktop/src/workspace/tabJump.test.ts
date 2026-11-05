import { expect, it, vi } from "vitest";
import { onTabJump, requestTabJump } from "./tabJump";

it("a request reaches the handler that knows the tab, until it is removed", () => {
  const jump = vi.fn((id: string) => id === "a");
  const off = onTabJump(jump);
  expect(requestTabJump("a")).toBe(true);
  expect(requestTabJump("b")).toBe(false);
  expect(jump).toHaveBeenCalledTimes(2);
  off();
  expect(requestTabJump("a")).toBe(false);
});
