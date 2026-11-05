import { describe, expect, it } from "vitest";
import type { SetEntry } from "@/api";
import { createMockApi } from "@/api";
import { withWaitKind, stepsValid } from "./StepsEditor";

const entry: SetEntry = { target: { type: "agent", profile: "claude" }, worktree: { type: "current" }, startup: [] };

describe("mock terminal sets", () => {
  it("stores a set, renames it in place and deletes it, announcing each change", async () => {
    const api = createMockApi({});
    const heard: string[][] = [];
    api.onSettingsChanged((e) => heard.push(e.sections));
    const saved = await api.terminalSetUpsert({ id: "", name: "Duo", entries: [entry, entry] });
    expect(saved.id).not.toBe("");
    await api.terminalSetUpsert({ ...saved, name: "Pair" });
    expect((await api.terminalSetsList()).map((s) => s.name)).toEqual(["Pair"]);
    await api.terminalSetDelete(saved.id);
    expect(await api.terminalSetsList()).toEqual([]);
    expect(heard.flat()).toContain("terminalSets");
  });

  it("rejects a bad name, no entries and an unknown agent with bad_arg", async () => {
    const api = createMockApi({});
    await expect(api.terminalSetUpsert({ id: "", name: " ", entries: [entry] })).rejects.toMatchObject({ code: "bad_arg" });
    await expect(api.terminalSetUpsert({ id: "", name: "x", entries: [] })).rejects.toMatchObject({ code: "bad_arg" });
    await expect(
      api.terminalSetUpsert({ id: "", name: "x", entries: [{ ...entry, target: { type: "agent", profile: "nope" } }] }),
    ).rejects.toMatchObject({ code: "bad_arg" });
  });

  it("stores and deletes a startup preset", async () => {
    const api = createMockApi({});
    const p = await api.startupPresetUpsert({ id: "", name: "Dev", steps: [{ command: "ls", wait: { type: "idle" } }] });
    expect(await api.startupPresetsList()).toHaveLength(1);
    await api.startupPresetDelete(p.id);
    expect(await api.startupPresetsList()).toEqual([]);
  });
});

describe("steps editor logic", () => {
  it("a wait of seconds keeps its number, else starts at 5", () => {
    const step = { command: "a", wait: { type: "seconds" as const, seconds: 9 } };
    expect(withWaitKind(step, "seconds").wait).toEqual({ type: "seconds", seconds: 9 });
    expect(withWaitKind({ command: "a", wait: { type: "none" } }, "seconds").wait).toEqual({ type: "seconds", seconds: 5 });
    expect(withWaitKind(step, "idle").wait).toEqual({ type: "idle" });
  });

  it("steps need a command and seconds from 1 to 3600", () => {
    expect(stepsValid([{ command: "a", wait: { type: "none" } }])).toBe(true);
    expect(stepsValid([{ command: " ", wait: { type: "none" } }])).toBe(false);
    expect(stepsValid([{ command: "a", wait: { type: "seconds", seconds: 0 } }])).toBe(false);
    expect(stepsValid([{ command: "a", wait: { type: "seconds", seconds: 3601 } }])).toBe(false);
  });
});
