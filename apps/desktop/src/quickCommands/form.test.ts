import { expect, it, vi } from "vitest";
import type { QuickCommand } from "@/api";
import { canSave, counterOf, draftOf, duplicateOf, emptyDraft, fieldOfError, saveDraft, toCommand, withType } from "./form";

it("creates a global terminal command: upsert gets the right shape", async () => {
  const upsert = vi.fn(async (c: QuickCommand) => ({ ...c, id: "qc-1" }));
  const d = { ...emptyDraft(null, "claude"), label: "  Git status ", command: "git status  \n" };
  const res = await saveDraft({ quickCommandUpsert: upsert }, d, "");
  expect(upsert).toHaveBeenCalledWith({
    id: "",
    label: "Git status",
    scope: { type: "global" },
    action: { type: "terminal", command: "git status", appendEnter: true },
  });
  expect(res).toMatchObject({ ok: true, saved: { id: "qc-1" } });
});

it("switching Type keeps the label and the other kind's fields", () => {
  const d = { ...emptyDraft(null, "claude"), label: "Tests", command: "cargo test", prompt: "Review" };
  const agent = withType(d, "agent");
  expect(agent.label).toBe("Tests");
  expect(toCommand(agent, "").action).toEqual({ type: "agent", profile: "claude", prompt: "Review" });
  expect(withType(agent, "terminal").command).toBe("cargo test");
});

it("scope This project fills repo; the repo on screen is the default", () => {
  const d = emptyDraft("/a", "claude");
  expect(d.scope).toBe("repo");
  expect(toCommand({ ...d, label: "x", command: "y" }, "qc-9").scope).toEqual({ type: "repo", repo: "/a" });
});

it("a bad_arg detail names the field; other errors name none", async () => {
  expect(fieldOfError({ code: "bad_arg", detail: "label" })).toBe("label");
  expect(fieldOfError({ code: "bad_arg", detail: "prompts" })).toBe("prompts");
  expect(fieldOfError({ code: "io" })).toBeNull();
  const res = await saveDraft({ quickCommandUpsert: async () => Promise.reject({ code: "bad_arg", detail: "command" }) }, emptyDraft(null, "claude"), "");
  expect(res).toEqual({ ok: false, field: "command", code: "bad_arg" });
});

it("counters show only near the limit", () => {
  const d = emptyDraft(null, "claude");
  expect(counterOf({ ...d, label: "short" }, "label")).toBeNull();
  expect(counterOf({ ...d, label: "x".repeat(70) }, "label")).toMatchObject({ used: 70, max: 80 });
  expect(counterOf({ ...d, prompt: "é".repeat(110_000) }, "prompt")).toMatchObject({ used: 220_000, bytes: true });
});

it("Save needs a label and the text of its kind", () => {
  const d = emptyDraft(null, "claude");
  expect(canSave(d)).toBe(false);
  expect(canSave({ ...d, label: "a", command: "b" })).toBe(true);
  expect(canSave({ ...d, label: "a", type: "agent", prompt: " " })).toBe(false);
  expect(canSave({ ...d, label: "a", scope: "repo", repo: "", command: "b" })).toBe(false);
});

it("draftOf and duplicateOf round trip", () => {
  const cmd: QuickCommand = { id: "qc-1", label: "x".repeat(80), scope: { type: "repo", repo: "/a" }, action: { type: "agent", profile: "claude", prompt: "p" } };
  expect(toCommand(draftOf(cmd, "claude"), "qc-1")).toEqual(cmd);
  const copy = duplicateOf(cmd, " (copy)");
  expect(copy.id).toBe("");
  expect([...copy.label]).toHaveLength(80);
  expect(copy.label.endsWith(" (copy)")).toBe(true);
});
