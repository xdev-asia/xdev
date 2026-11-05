import { describe, expect, it, vi } from "vitest";
import { pastePrompt } from "@/workspace/agentPrompt";
import { CONTEXT_LINES } from "@/terminal/terminalActions";
import type { Api, SessionRow } from "@/api";
import { CUT_MARK, FIRST_PROMPT_MAX, handoffPrompt, sourceFirstPrompt, transcriptText, TRANSCRIPT_MAX } from "./handoff";

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

describe("transcriptText", () => {
  const turn = (role: "user" | "assistant", text: string) => ({ role, text });

  it("is empty with no turns or only blank ones", () => {
    expect(transcriptText([])).toBe("");
    expect(transcriptText([turn("user", "  \n ")])).toBe("");
  });

  it("keeps every turn, oldest first, when it fits", () => {
    const text = transcriptText([turn("user", "fix it"), turn("assistant", "done")]);
    expect(text).toBe("User: fix it\n\nAgent: done");
    expect(text).not.toContain(CUT_MARK);
  });

  it("keeps the newest turns and marks the cut when over the cap", () => {
    const turns = Array.from({ length: 30 }, (_, i) => turn(i % 2 === 0 ? "user" : "assistant", `turn-${i} ${"x".repeat(500)}`));
    const text = transcriptText(turns);
    expect(text.length).toBeLessThanOrEqual(TRANSCRIPT_MAX);
    expect(text.startsWith(CUT_MARK)).toBe(true);
    expect(text).toContain("turn-29 ");
    expect(text).not.toContain("turn-0 ");
    // Order is kept among the turns that stay.
    const seen = [...text.matchAll(/turn-(\d+) /g)].map((m) => Number(m[1]));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(29);
  });

  it("keeps the end of one turn that is longer than the cap", () => {
    const text = transcriptText([turn("user", `${"a".repeat(9000)}END`)], 100);
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.startsWith(CUT_MARK)).toBe(true);
    expect(text.endsWith("END")).toBe(true);
  });

  it("honours a smaller cap", () => {
    expect(transcriptText([turn("user", "a".repeat(50)), turn("assistant", "b".repeat(50))], 80).length).toBeLessThanOrEqual(80);
  });
});

it("a prompt with a transcript carries it instead of the terminal lines", () => {
  const text = handoffPrompt({ ...base, transcript: "User: hi\n\nAgent: hello" });
  expect(text).toContain("User: hi");
  expect(text).toContain("Worktree: /w/oak (feat/oak)");
  expect(text).not.toContain("one\ntwo");
  expect(handoffPrompt({ ...base, transcript: "" })).toContain("one\ntwo");
});
