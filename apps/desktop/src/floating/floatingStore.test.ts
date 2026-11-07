import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { NOTE_MAX_BYTES } from "./floatingSnapshot";
import type { PtyClient } from "@/terminal/ptyClient";

const openBrowserTab = vi.fn(() => "browser-tab-1");
const closeBrowserTab = vi.fn();
const browserEntries = new Map<string, { url: string; title: string | null }>();
vi.mock("@/browser/browserTabs", () => ({
  browserTab: (id: string) => browserEntries.get(id),
  openBrowserTab: (...a: unknown[]) => openBrowserTab(...(a as [])),
  closeBrowserTab: (...a: unknown[]) => closeBrowserTab(...(a as [])),
}));

import {
  FLOATING_WORKTREE,
  addFloatingTab,
  closeFloating,
  applyRestored,
  clientOf,
  closeFloatingTab,
  registerFloatingClient,
  setFloatingCwd,
  setNoteBody,
  snapshotFloating,
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
  browserEntries.clear();
});

const TERM_ID = /^floating-term-[0-9a-f-]{36}$/;
const api = createMockApi({});
const fakeClient = (seq = 0) => {
  const dispose = vi.fn(async () => {});
  return { client: { seq, dispose } as unknown as PtyClient, dispose };
};

describe("homeDir", () => {
  it("the mock api answers", async () => {
    expect(await createMockApi({}).homeDir()).toBe("/home/demo");
  });
});

describe("open and toggle", () => {
  it("the first open adds one terminal tab, a later open adds nothing", () => {
    openFloating();
    expect(floatingState().open).toBe(true);
    const [tab] = floatingState().tabs;
    expect(tab).toMatchObject({ kind: "terminal", n: 1 });
    expect(tab.id).toMatch(TERM_ID);
    expect(floatingState().active).toBe(tab.id);
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
  it("terminal ids are unique and the display number rises", () => {
    const a = addFloatingTab("terminal") as string;
    const b = addFloatingTab("terminal") as string;
    expect(a).toMatch(TERM_ID);
    expect(b).toMatch(TERM_ID);
    expect(a).not.toBe(b);
    expect(floatingState().tabs.map((t) => t.n)).toEqual([1, 2]);
    expect(floatingState().active).toBe(b);
  });

  it("a browser tab uses the id of the browser store", () => {
    const id = addFloatingTab("browser");
    expect(openBrowserTab).toHaveBeenCalledWith(FLOATING_WORKTREE);
    expect(id).toBe("browser-tab-1");
    expect(floatingState().tabs[0]).toMatchObject({ id: "browser-tab-1", kind: "browser" });
  });

  it("adds a note each time, up to 8", () => {
    const ids = Array.from({ length: 8 }, () => addFloatingTab("note"));
    expect(new Set(ids).size).toBe(8);
    expect(addFloatingTab("note")).toBeNull();
    expect(floatingState().tabs).toHaveLength(8);
  });

  it("closing makes the right neighbour active, else the left", () => {
    const a = addFloatingTab("terminal") as string;
    const b = addFloatingTab("terminal") as string;
    const c = addFloatingTab("terminal") as string;
    selectFloatingTab(b);
    closeFloatingTab(b);
    expect(floatingState().active).toBe(c);
    closeFloatingTab(c);
    expect(floatingState().active).toBe(a);
  });

  it("closing the last tab clears active and keeps open", () => {
    openFloating();
    closeFloatingTab(floatingState().tabs[0].id);
    expect(floatingState().active).toBeNull();
    expect(floatingState().open).toBe(true);
  });

  it("closing a browser tab closes it in the browser store", () => {
    const id = addFloatingTab("browser");
    closeFloatingTab(id);
    expect(closeBrowserTab).toHaveBeenCalledWith(id);
  });

  it("step wraps", () => {
    const a = addFloatingTab("terminal") as string;
    const b = addFloatingTab("terminal") as string;
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

describe("clients", () => {
  it("clientOf returns the same client each time", () => {
    const id = addFloatingTab("terminal") as string;
    const c = clientOf(id, api);
    expect(clientOf(id)).toBe(c);
    expect(c.id).toBe(id);
  });

  it("closing a terminal disposes its client once and drops it", () => {
    const id = addFloatingTab("terminal") as string;
    const { client, dispose } = fakeClient();
    registerFloatingClient(id, client);
    closeFloatingTab(id);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => clientOf(id)).toThrow();
  });
});

describe("restore numbering", () => {
  it("goes on from the highest restored number", () => {
    applyRestored([{ id: "floating-term-a", kind: "terminal", n: 4 }], "floating-term-a");
    addFloatingTab("terminal");
    expect(floatingState().tabs.map((t) => t.n)).toEqual([4, 5]);
  });

  it("appends after open tabs and keeps the active one", () => {
    const mine = addFloatingTab("terminal") as string;
    applyRestored([{ id: "floating-term-a", kind: "terminal", n: 4 }], "floating-term-a");
    expect(floatingState().tabs.map((t) => t.id)).toEqual([mine, "floating-term-a"]);
    expect(floatingState().active).toBe(mine);
    expect(floatingState().open).toBe(false);
  });

  it("takes the restored active when nothing was open", () => {
    applyRestored([{ id: "a", kind: "note", n: 1, body: "" }, { id: "b", kind: "note", n: 2, body: "" }], "b");
    expect(floatingState().active).toBe("b");
  });
});

describe("notes and cwd", () => {
  it("setNoteBody saves and tells once", () => {
    const id = addFloatingTab("note") as string;
    const fn = vi.fn();
    subscribeFloating(fn);
    expect(setNoteBody(id, "hello")).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(floatingState().tabs[0].body).toBe("hello");
  });

  it("setNoteBody refuses text over 256 KiB and keeps the old body", () => {
    const id = addFloatingTab("note") as string;
    setNoteBody(id, "keep");
    expect(setNoteBody(id, "é".repeat(NOTE_MAX_BYTES / 2 + 1))).toBe(false);
    expect(floatingState().tabs[0].body).toBe("keep");
    expect(setNoteBody(id, "é".repeat(NOTE_MAX_BYTES / 2))).toBe(true);
  });

  it("setFloatingCwd tells once and ignores the same value", () => {
    const id = addFloatingTab("terminal") as string;
    const fn = vi.fn();
    subscribeFloating(fn);
    setFloatingCwd(id, "/work");
    setFloatingCwd(id, "/work");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(floatingState().tabs[0].cwd).toBe("/work");
  });
});

describe("snapshotFloating", () => {
  it("reads the live seq, the browser url and title, and active as an index", () => {
    const term = addFloatingTab("terminal") as string;
    registerFloatingClient(term, fakeClient(42).client);
    setFloatingCwd(term, "/work");
    const br = addFloatingTab("browser") as string;
    browserEntries.set(br, { url: "https://example.com", title: "Ex" });
    const note = addFloatingTab("note") as string;
    setNoteBody(note, "hi");
    selectFloatingTab(br);
    const snap = snapshotFloating();
    expect(snap.active).toBe(1);
    expect(snap.tabs).toEqual([
      { kind: "terminal", id: term, n: 1, cwd: "/work", seq: 42 },
      { kind: "browser", url: "https://example.com", title: "Ex" },
      { kind: "note", n: 1, body: "hi" },
    ]);
  });

  it("has a null active with no tabs", () => {
    expect(snapshotFloating()).toMatchObject({ version: 1, active: null, tabs: [] });
  });
});
