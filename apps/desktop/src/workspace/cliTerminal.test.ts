import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import type { CliTerminal } from "@/api";
import { PtyClient } from "@/terminal/ptyClient";
import { leaves, paneOf } from "./paneTree";
import { Sessions } from "./sessions";
import { defaultShell, runCliTerminal, startCliTerminal } from "./cliTerminal";

const WT = "/w/lead";
const flush = () => new Promise((r) => setTimeout(r, 0));
const ev = (over: Partial<CliTerminal>): CliTerminal => ({ op: "create", id: "t-new", worktree: WT, source: null, dir: null, cwd: null, cmd: null, title: null, ...over });

describe("cli terminal", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
    vi.restoreAllMocks();
  });

  function setup() {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const mounted: string[] = [];
    return { api, live, host: { sessions: live, ensureMounted: (w: string) => void mounted.push(w) }, mounted };
  }

  it("create opens the default shell with the given id, name and folder, then runs the command", async () => {
    const typed = vi.spyOn(PtyClient.prototype, "typeWhenReady").mockImplementation(() => {});
    const { api, live, host, mounted } = setup();
    const shell = await defaultShell(api);
    await runCliTerminal(api, host, ev({ title: "build", cwd: "src/app", cmd: "make test" }));
    const tab = live.tab("t-new")!;
    expect(tab.profileId).toBe(shell);
    expect(tab.title).toBe("build");
    expect(tab.renamed).toBe(true);
    expect(tab.dir).toBe("src/app");
    expect(mounted).toEqual([WT]);
    expect(typed).toHaveBeenCalledTimes(1);
    expect(typed.mock.calls[0][0]).toMatch(/^make test(\r|\n)/);
    // The same event again is one tab.
    await runCliTerminal(api, host, ev({}));
    expect(live.tabs(WT)).toHaveLength(1);
  });

  it("create with no command types nothing", async () => {
    const typed = vi.spyOn(PtyClient.prototype, "typeWhenReady").mockImplementation(() => {});
    const { api, live, host } = setup();
    await runCliTerminal(api, host, ev({}));
    expect(live.tab("t-new")!.dir).toBeUndefined();
    expect(typed).not.toHaveBeenCalled();
  });

  it("split puts the new shell in a new pane beside the source tab", async () => {
    const { api, live, host } = setup();
    const shell = (await defaultShell(api))!;
    const a = live.open(WT, shell);
    live.open(WT, shell);
    const before = leaves(live.layout(WT)!).length;
    await runCliTerminal(api, host, ev({ op: "split", source: a.id, dir: "down", cwd: "src" }));
    const layout = live.layout(WT)!;
    expect(leaves(layout).filter((n) => n.kind === "leaf")).toHaveLength(before + 1);
    expect(paneOf(layout, "t-new")).not.toBe(paneOf(layout, a.id));
    expect(live.tab("t-new")!.dir).toBe("src");
  });

  it("close closes the tab, and a gone one is nothing", async () => {
    const { api, live, host } = setup();
    await runCliTerminal(api, host, ev({}));
    await runCliTerminal(api, host, ev({ op: "close" }));
    expect(live.tab("t-new")).toBeNull();
    await runCliTerminal(api, host, ev({ op: "close" }));
  });

  it("follows the events until stopped", async () => {
    const { api, live, host } = setup();
    const stop = startCliTerminal(api, host);
    await flush();
    api.__cliTerminal(ev({}));
    await vi.waitFor(() => expect(live.tab("t-new")).not.toBeNull());
    stop();
    await flush();
    api.__cliTerminal(ev({ id: "t-two" }));
    await flush();
    await flush();
    expect(live.tab("t-two")).toBeNull();
  });
});
