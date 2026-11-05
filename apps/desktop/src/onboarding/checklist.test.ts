import { expect, it } from "vitest";
import { deriveChecklist, doneCount, isComplete, type Known } from "./checklist";

const fresh: Known = { defaultAgent: "auto", theme: "system", storedLocale: false, projects: 0 };
const ids = (rows: ReturnType<typeof deriveChecklist>) => rows.filter((r) => r.done).map((r) => r.id);

it("nothing is done on a fresh install", () => {
  const rows = deriveChecklist(fresh, {});
  expect(rows.map((r) => r.id)).toEqual(["agent", "theme", "language", "notifications", "project"]);
  expect(doneCount(rows)).toBe(0);
  expect(isComplete(rows)).toBe(false);
});

it("derives from the app state first", () => {
  expect(ids(deriveChecklist({ defaultAgent: "claude", theme: "dark", storedLocale: true, projects: 2 }, {}))).toEqual(["agent", "theme", "language", "project"]);
});

it("falls back to the wizard's answers, and notifications only count when allowed", () => {
  const unknown: Known = { defaultAgent: null, theme: null, storedLocale: false, projects: null };
  expect(ids(deriveChecklist(unknown, { agent: "auto", theme: "system", language: "en", notifications: "denied" }))).toEqual(["agent", "theme", "language"]);
  expect(ids(deriveChecklist(unknown, { notifications: "allowed" }))).toEqual(["notifications"]);
});

it("is complete when all five are done", () => {
  expect(isComplete(deriveChecklist({ ...fresh, projects: 1 }, { agent: "auto", theme: "system", language: "en", notifications: "allowed" }))).toBe(true);
});
