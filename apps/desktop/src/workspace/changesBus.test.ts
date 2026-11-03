import { expect, it, vi } from "vitest";
import { onChangesTouched, touchChanges } from "./changesBus";

it("tells only the listeners of that worktree, until they stop", () => {
  const a = vi.fn();
  const b = vi.fn();
  const stopA = onChangesTouched("/wt/a", a);
  onChangesTouched("/wt/b", b)();
  touchChanges("/wt/a");
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).not.toHaveBeenCalled();
  stopA();
  touchChanges("/wt/a");
  expect(a).toHaveBeenCalledTimes(1);
  const own = vi.fn();
  const other = vi.fn();
  onChangesTouched("/wt/c", own);
  onChangesTouched("/wt/c", other);
  touchChanges("/wt/c", own);
  expect(own).not.toHaveBeenCalled();
  expect(other).toHaveBeenCalledTimes(1);
});
