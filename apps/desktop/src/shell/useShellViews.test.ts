import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DOCS_SEARCH_ID } from "@/docs/ids";

// Hooks are stubbed with a cursor, the way the shell tests do it: no DOM renderer is needed.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (v: unknown) => void (hooks.values[index] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks.values[index]) : v)];
  },
}));

import { useShellViews } from "./useShellViews";

const draw = () => {
  hooks.cursor = 0;
  return useShellViews();
};

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("openTask shows tasks with the task", () => {
  draw().openTask("t1");
  const v = draw();
  expect(v.view).toBe("tasks");
  expect(v.tasksRequest).toEqual({ task: "t1", seq: 1 });
  v.openTask("t2");
  expect(draw().tasksRequest).toEqual({ task: "t2", seq: 2 });
});

it("the board and decompose requests carry their fields", () => {
  draw().openTaskBoard("f1");
  expect(draw().tasksRequest).toEqual({ tab: "board", boardTask: "f1", seq: 1 });
  draw().openDecompose();
  expect(draw().tasksRequest).toEqual({ tab: "board", decompose: true, seq: 2 });
});

it("openAccounts twice bumps nothing but shows accounts", () => {
  draw().openAccounts();
  expect(draw().view).toBe("accounts");
  draw().openAccounts();
  expect(draw().view).toBe("accounts");
  expect(draw().tasksRequest).toBeNull();
});

it("a place mounts on first show and stays mounted", () => {
  expect(draw().mounted.has("kit")).toBe(false);
  draw().show("kit");
  expect(draw().mounted.has("kit")).toBe(true);
  draw().show("docs");
  const v = draw();
  expect(v.mounted.has("kit")).toBe(true);
  expect(v.mounted.has("docs")).toBe(true);
});

it("openDocsSection shows docs on that section", () => {
  draw().openDocsSection("agents");
  const v = draw();
  expect(v.view).toBe("docs");
  expect(v.docsRequest).toEqual({ section: "agents", seq: 1 });
});

it("openDoc shows docs with a request that names the doc, and a new one each time", () => {
  draw().openDoc("a.md");
  expect(draw().view).toBe("docs");
  expect(draw().docsRequest).toEqual({ section: "docs", open: "a.md", seq: 1 });
  draw().openDoc("a.md");
  expect(draw().docsRequest?.seq).toBe(2);
});

it("openSearch shows docs and focuses the docs search", () => {
  vi.useFakeTimers();
  const box = { focus: vi.fn(), select: vi.fn() };
  const getElementById = vi.fn(() => box);
  vi.stubGlobal("document", { getElementById });
  draw().openSearch();
  expect(draw().view).toBe("docs");
  vi.runAllTimers();
  expect(getElementById).toHaveBeenCalledWith(DOCS_SEARCH_ID);
  expect(box.focus).toHaveBeenCalledTimes(1);
  expect(box.select).toHaveBeenCalledTimes(1);
});

it("opens the drawer before focusing the docs search at narrow width", () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const box = { focus: () => calls.push("focus"), select: () => {} };
  vi.stubGlobal("document", { getElementById: () => box });
  draw().openSearch(true, () => calls.push("openNav"));
  expect(calls).toEqual(["openNav"]);
  vi.runAllTimers();
  expect(calls).toEqual(["openNav", "focus"]);
});

it("openSearch at desktop width does not open the drawer", () => {
  vi.useFakeTimers();
  const openNav = vi.fn();
  vi.stubGlobal("document", { getElementById: () => null });
  draw().openSearch(false, openNav);
  vi.runAllTimers();
  expect(openNav).not.toHaveBeenCalled();
});
