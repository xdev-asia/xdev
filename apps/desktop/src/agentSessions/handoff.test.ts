import { expect, it, vi } from "vitest";
import { pastePrompt } from "@/workspace/agentPrompt";
import { CONTEXT_LINES } from "@/terminal/terminalActions";
import type { Api, SessionRow } from "@/api";
import { FIRST_PROMPT_MAX, handoffPrompt, sourceFirstPrompt } from "./handoff";

const base = { fromProfile: "Codex", worktree: "/w/oak", branch: "feat/oak", firstPrompt: "Fix the parser", lines: ["one", "two"] };

it("holds the source agent, worktree, branch, first prompt and terminal lines", () => {
  const text = handoffPrompt(base);
  for (const part of ["Codex", "/w/oak", "feat/oak", "Fix the parser", "one\ntwo"]) expect(text).toContain(part);
});

it("leaves out the branch and the first prompt when unknown", () => {
  const text = handoffPrompt({ ...base, branch: null, firstPrompt: null });
  expect(text).toContain("Worktree: /w/oak\n");
  expect(text).not.toContain("first request");
});

it("keeps only the last CONTEXT_LINES lines", () => {
  const lines = Array.from({ length: CONTEXT_LINES + 50 }, (_, i) => `line-${i}`);
  const text = handoffPrompt({ ...base, lines });
  expect(text).toContain(`line-${CONTEXT_LINES + 49}`);
  expect(text).toContain("line-50\n");
  expect(text).not.toContain("line-49\n");
});

it("has no control characters between the paste markers once pasted", () => {
  const pasted = pastePrompt(handoffPrompt({ ...base, lines: ["a\u0007b", "\u001b[31mred"] }));
  const inner = pasted.slice("\u001b[200~".length, pasted.lastIndexOf("\u001b[201~"));
  // eslint-disable-next-line no-control-regex
  expect(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(inner)).toBe(false);
});

function apiWith(rows: unknown[] | Error) {
  const agentSessions = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows as SessionRow[];
  });
  return { api: { agentSessions } as unknown as Pick<Api, "agentSessions">, agentSessions };
}

it("sourceFirstPrompt reads the session index for the source session and caps it", async () => {
  const long = "x".repeat(FIRST_PROMPT_MAX + 50);
  const { api, agentSessions } = apiWith([{ session: { id: "s1", title: long } }]);
  const got = await sourceFirstPrompt(api, "/w/oak", "s1");
  expect(Array.from(got!).length).toBe(FIRST_PROMPT_MAX);
  expect(agentSessions).toHaveBeenCalledWith(expect.objectContaining({ text: "s1", scope: { kind: "worktree", path: "/w/oak" }, limit: 1 }), true);
});

it("sourceFirstPrompt falls back to null: no session, no row, a failure", async () => {
  const none = apiWith([]);
  expect(await sourceFirstPrompt(none.api, "/w", null)).toBeNull();
  expect(none.agentSessions).not.toHaveBeenCalled();
  expect(await sourceFirstPrompt(none.api, "/w", "s1")).toBeNull();
  expect(await sourceFirstPrompt(apiWith([{ session: { id: "other", title: "t" } }]).api, "/w", "s1")).toBeNull();
  expect(await sourceFirstPrompt(apiWith(new Error("io")).api, "/w", "s1")).toBeNull();
});
