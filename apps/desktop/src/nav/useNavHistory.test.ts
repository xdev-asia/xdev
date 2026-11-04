import { beforeEach, expect, it, vi } from "vitest";
import { useNavHistory } from "./useNavHistory";

const hooks = vi.hoisted(() => ({ refs: [] as { current: unknown }[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => (hooks.refs[hooks.cursor] ??= { current: initial }, hooks.refs[hooks.cursor++]),
  useSyncExternalStore: (_sub: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: () => void) => void hooks.effects.push(effect),
}));

beforeEach(() => { hooks.refs = []; hooks.cursor = 0; hooks.effects = []; });

// One render: the hook runs, then its effects (as React would after commit).
function render(args: Parameters<typeof useNavHistory>[0]) {
  hooks.cursor = 0;
  hooks.effects = [];
  const api = useNavHistory(args);
  hooks.effects.forEach((e) => e());
  return api;
}

it("back goes to the previous worktree and the effect that follows does not push", () => {
  const go = vi.fn();
  const alive = () => true;
  render({ current: "A", tab: "a1", alive, go });
  render({ current: "B", tab: "b1", alive, go });
  let api = render({ current: "B", tab: "b1", alive, go });
  expect(api.canBack).toBe(true);
  expect(api.canForward).toBe(false);
  expect(api.back()).toBe(true);
  expect(go).toHaveBeenCalledWith({ worktree: "A", tab: "a1" });
  // The shell selects A; the effect runs with the new selection.
  api = render({ current: "A", tab: "a1", alive, go });
  expect(api.canForward).toBe(true);
  expect(api.canBack).toBe(false);
  expect(api.forward()).toBe(true);
  expect(go).toHaveBeenLastCalledWith({ worktree: "B", tab: "b1" });
});

it("back and forward return false when there is nowhere to go", () => {
  const go = vi.fn();
  const api = render({ current: "A", tab: null, alive: () => true, go });
  expect(api.back()).toBe(false);
  expect(api.forward()).toBe(false);
  expect(go).not.toHaveBeenCalled();
});

it("a tab change in the same worktree does not push", () => {
  const go = vi.fn();
  const alive = () => true;
  render({ current: "A", tab: "a1", alive, go });
  const api = render({ current: "A", tab: "a2", alive, go });
  expect(api.canBack).toBe(false);
});

it("no worktree selected records nothing", () => {
  const api = render({ current: null, tab: null, alive: () => true, go: vi.fn() });
  expect(api.canBack).toBe(false);
});
