import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { translate } from "@/i18n";
import { ASK_TTL_MS, startCliEvents } from "./cliEvents";
import { onOpenFile, type OpenFileRequest } from "@/files/openFile";
import { getToasts, resetToastsForTests } from "./toastStore";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("CLI events", () => {
  beforeEach(() => resetToastsForTests());
  afterEach(() => {
    resetToastsForTests();
    vi.useRealTimers();
  });

  it("reloads the sidebar on a registry change and opens the asked tab", async () => {
    const api = createMockApi({});
    const reload = vi.fn();
    const openTab = vi.fn();
    const stop = startCliEvents(api, { reload, openTab, t });
    await flush();
    api.__cliWorkspaceChanged();
    api.__cliOpenTab({ worktree: "/w/sub", profile: "claude", prompt: "say hi" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(openTab).toHaveBeenCalledWith("/w/sub", "claude", "say hi");
    stop();
    await flush();
    api.__cliWorkspaceChanged();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("asks with Allow / Deny and sends the answer once", async () => {
    const api = createMockApi({});
    startCliEvents(api, { reload() {}, openTab() {}, t });
    await flush();
    api.__cliAsk({ request: 4, caller: "/w/lead", verb: "worktree.set", target: "/w/other" });
    const [toast] = getToasts();
    expect(toast.text).toBe(t("cli.ask", { who: "lead", verb: t("cli.ask.set"), target: "other" }));
    expect(toast.actions.map((a) => a.label)).toEqual([t("cli.ask.allow"), t("cli.ask.deny")]);
    toast.actions[1].run();
    await flush();
    expect(api.__cliAnswers()).toEqual([{ request: 4, allow: false }]);
    expect(getToasts()).toEqual([]);
  });

  it("says a send types into a terminal, not that it changes details", async () => {
    const api = createMockApi({});
    startCliEvents(api, { reload() {}, openTab() {}, t });
    await flush();
    api.__cliAsk({ request: 6, caller: "/w/lead", verb: "terminal.send", target: "/w/other" });
    expect(getToasts()[0].text).toBe("lead wants to type into a terminal of other.");
    expect(translate("vi", "cli.ask.send")).not.toBe("cli.ask.send");
  });

  it("names an outside caller and goes away after 60 s without an answer", async () => {
    vi.useFakeTimers();
    const api = createMockApi({});
    startCliEvents(api, { reload() {}, openTab() {}, t });
    await vi.advanceTimersByTimeAsync(0);
    api.__cliAsk({ request: 5, caller: null, verb: "worktree.create", target: "/w/x" });
    expect(getToasts()[0].text).toBe(t("cli.ask", { who: t("cli.ask.external"), verb: t("cli.ask.create"), target: "x" }));
    await vi.advanceTimersByTimeAsync(ASK_TTL_MS - 1);
    expect(getToasts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getToasts()).toEqual([]);
    expect(api.__cliAnswers()).toEqual([]);
  });

  it("opens the file the CLI names, with its position when it has one", async () => {
    const api = createMockApi({});
    const seen: OpenFileRequest[] = [];
    const off = onOpenFile((req) => seen.push(req));
    const stop = startCliEvents(api, { reload() {}, openTab() {}, t });
    await flush();
    api.__cliOpenFile({ worktree: "/w/lead", path: "src/a.ts", line: 12, column: null });
    api.__cliOpenFile({ worktree: "/w/lead", path: "b.ts", line: null, column: null });
    expect(seen).toEqual([
      { worktree: "/w/lead", rel: "src/a.ts", line: 12, column: undefined },
      { worktree: "/w/lead", rel: "b.ts", line: undefined, column: undefined },
    ]);
    stop();
    off();
  });

  it("words an automation write as a change to one that runs in the worktree", async () => {
    const api = createMockApi({});
    startCliEvents(api, { reload() {}, openTab() {}, t });
    await flush();
    api.__cliAsk({ request: 8, caller: "/w/lead", verb: "automation.remove", target: "/w/other" });
    expect(getToasts()[0].text).toBe("lead wants to change an automation that runs in other.");
    expect(translate("vi", "cli.ask.automation")).not.toBe("cli.ask.automation");
  });
});
