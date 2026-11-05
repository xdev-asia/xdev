import { expect, it } from "vitest";
import type { FileAttribution, Toucher } from "@/api";
import { agentCount, chipNames, isMulti, letterOf, multiPaths, profileOf, touchersByPath } from "./attributionModel";

const who = (tabId: string | null, agent: string | null, at = 1): Toucher => ({ tabId, agent, at });

it("a file is multi-agent when two different tabs touched it", () => {
  expect(isMulti([who("t1", "claude"), who("t2", "codex")])).toBe(true);
  expect(isMulti([who("t1", "claude"), who("t2", "claude")])).toBe(true);
  expect(isMulti([who("t1", "claude")])).toBe(false);
  expect(isMulti([who("t1", "claude"), who(null, null)])).toBe(false);
  expect(isMulti(undefined)).toBe(false);
  expect(agentCount([who("t1", "claude"), who("t2", "codex"), who(null, null)])).toBe(2);
});

it("the filter keeps the files that several tabs touched", () => {
  const files: FileAttribution[] = [
    { path: "a.ts", touchedBy: [who("t1", "claude"), who("t2", "codex")] },
    { path: "b.ts", touchedBy: [who("t1", "claude")] },
  ];
  const by = touchersByPath(files);
  expect(multiPaths(["a.ts", "b.ts", "c.ts"], by)).toEqual(["a.ts"]);
});

it("chips map claude and codex to their profile and the rest to custom", () => {
  expect(profileOf("claude")).toBe("claude");
  expect(profileOf("codex")).toBe("codex");
  expect(profileOf("aider")).toBe("custom");
  expect(profileOf(null)).toBe("custom");
  expect(letterOf("aider")).toBe("A");
  expect(letterOf("codex")).toBeUndefined();
  expect(letterOf(null)).toBe("?");
});

it("two chips of one agent are told apart by their tab", () => {
  expect(chipNames([who("tab-1234", "claude"), who("tab-5678", "claude"), who("t3", "codex")], "Unknown")).toEqual(["claude 1234", "claude 5678", "codex"]);
  expect(chipNames([who(null, null)], "Unknown")).toEqual(["Unknown"]);
});
