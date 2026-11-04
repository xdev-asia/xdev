import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { askQuit, quitAsk } from "./quitGuard";
import { Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";

describe("quitAsk", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });
  const tabs = () => {
    const s = (sessions = new Sessions(createMockApi({})));
    const agent = s.open(A, "claude");
    s.rename(agent.id, "Fix the parser");
    s.open(A, "shell");
    return s.tabs(A).map((t) => (t.id === agent.id ? { ...t, status: "working" as const } : t));
  };

  it("asks only for Ask, with the service running and a tab alive", () => {
    const all = tabs();
    const ask = quitAsk("ask", "running", all)!;
    expect(ask.count).toBe(2);
    expect(ask.working.map((w) => w.title)).toEqual(["Fix the parser"]);
    expect(quitAsk("ask", "old-version", all)?.count).toBe(2);
    expect(quitAsk("keep", "running", all)).toBeNull();
    expect(quitAsk("end", "running", all)).toBeNull();
    // In the app, terminals end with it anyway: nothing to choose.
    expect(quitAsk("ask", "fallback", all)).toBeNull();
    expect(quitAsk("ask", "off", all)).toBeNull();
    expect(quitAsk("ask", "running", [])).toBeNull();
  });

  it("does not count tabs that exited", () => {
    const all = tabs().map((t, i) => (i === 1 ? { ...t, exitCode: 0 } : t));
    expect(quitAsk("ask", "running", all)?.count).toBe(1);
  });
});

describe("askQuit", () => {
  it("lets the close go on with no question, and records the answer when there is one", async () => {
    const api = createMockApi({});
    api.__ptydSet({ state: "running" });
    const tab = { id: "t", title: null, profileId: "shell", status: "idle", exitCode: undefined } as never;
    const show = vi.fn(async () => "end" as const);
    expect(await askQuit(api, () => "keep", () => [tab], show)).toBe(true);
    expect(show).not.toHaveBeenCalled();
    expect(await askQuit(api, () => "ask", () => [tab], show)).toBe(true);
    expect(show).toHaveBeenCalledWith({ count: 1, working: [] });
    expect(api.__quitChoice()).toBe(true);
    expect(await askQuit(api, () => "ask", () => [tab], async () => "keep")).toBe(true);
    expect(api.__quitChoice()).toBe(false);
    expect(await askQuit(api, () => "ask", () => [tab], async () => "cancel")).toBe(false);
  });
});
