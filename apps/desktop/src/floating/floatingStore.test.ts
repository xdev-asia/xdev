import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";

const openBrowserTab = vi.fn(() => "browser-tab-1");
const closeBrowserTab = vi.fn();
vi.mock("@/browser/browserTabs", () => ({
  openBrowserTab: (...a: unknown[]) => openBrowserTab(...(a as [])),
  closeBrowserTab: (...a: unknown[]) => closeBrowserTab(...(a as [])),
}));

import {
  FLOATING_WORKTREE,
  addFloatingTab,
  closeFloating,
  closeFloatingTab,
  floatingState,
  focusInFloating,
  openFloating,
  resetFloatingForTests,
  selectFloatingTab,
  stepFloatingTab,
  subscribeFloating,
  toggleFloating,
} from "./floatingStore";

beforeEach(() => {
  resetFloatingForTests();
  openBrowserTab.mockClear();
  closeBrowserTab.mockClear();
});

describe("homeDir", () => {
  it("the mock api answers", async () => {
    expect(await createMockApi({}).homeDir()).toBe("/home/demo");
  });
});

describe("open and toggle", () => {
  it("the first open adds one terminal tab, a later open adds nothing", () => {
    openFloating();
    expect(floatingState().open).toBe(true);
    expect(floatingState().tabs).toEqual([{ id: "floating-term-1", kind: "terminal", n: 1 }]);
    expect(floatingState().active).toBe("floating-term-1");
    closeFloating();
    openFloating();
    expect(floatingState().tabs).toHaveLength(1);
  });

  it("toggle flips open and keeps the tabs", () => {
    toggleFloating();
    expect(floatingState().open).toBe(true);
    toggleFloating();
    expect(floatingState().open).toBe(false);
    expect(floatingState().tabs).toHaveLength(1);
  });
});

describe("tabs", () => {
  it("terminal ids rise", () => {
    expect(addFloatingTab("terminal")).toBe("floating-term-1");
    expect(addFloatingTab("terminal")).toBe("floating-term-2");
    expect(floatingState().active).toBe("floating-term-2");
  });

  it("a browser tab uses the id of the browser store", () => {
    const id = addFloatingTab("browser");
    expect(openBrowserTab).toHaveBeenCalledWith(FLOATING_WORKTREE);
    expect(id).toBe("browser-tab-1");
    expect(floatingState().tabs[0]).toMatchObject({ id: "browser-tab-1", kind: "browser" });
  });

  it("the note tab is unique", () => {
    const a = addFloatingTab("note");
    const b = addFloatingTab("note");
    expect(b).toBe(a);
    expect(floatingState().tabs).toHaveLength(1);
  });

  it("closing makes the right neighbour active, else the left", () => {
    const a = addFloatingTab("terminal");
    const b = addFloatingTab("terminal");
    const c = addFloatingTab("terminal");
    selectFloatingTab(b);
    closeFloatingTab(b);
    expect(floatingState().active).toBe(c);
    closeFloatingTab(c);
    expect(floatingState().active).toBe(a);
  });

  it("closing the last tab clears active and keeps open", () => {
    openFloating();
    closeFloatingTab("floating-term-1");
    expect(floatingState().active).toBeNull();
    expect(floatingState().open).toBe(true);
  });

  it("closing a browser tab closes it in the browser store", () => {
    const id = addFloatingTab("browser");
    closeFloatingTab(id);
    expect(closeBrowserTab).toHaveBeenCalledWith(id);
  });

  it("step wraps", () => {
    const a = addFloatingTab("terminal");
    const b = addFloatingTab("terminal");
    stepFloatingTab(1);
    expect(floatingState().active).toBe(a);
    stepFloatingTab(-1);
    expect(floatingState().active).toBe(b);
  });
});

describe("focusInFloating", () => {
  it("is true only inside the panel", () => {
    expect(focusInFloating({ closest: (s: string) => (s === ".floating-ws" ? {} : null) } as unknown as Element)).toBe(true);
    expect(focusInFloating({ closest: () => null } as unknown as Element)).toBe(false);
    expect(focusInFloating(null)).toBe(false);
  });
});

describe("subscribe", () => {
  it("tells once per real change", () => {
    const fn = vi.fn();
    const off = subscribeFloating(fn);
    openFloating();
    expect(fn).toHaveBeenCalledTimes(1);
    openFloating();
    expect(fn).toHaveBeenCalledTimes(1);
    selectFloatingTab(floatingState().active as string);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
});
