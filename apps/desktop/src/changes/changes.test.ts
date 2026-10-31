import { describe, expect, it } from "vitest";
import type { Change } from "../api";
import en from "../i18n/en.json";
import { countLabel, rejectPrompt, sortChanges } from "./changes";

const added: Change = { path: "notes/new.md", kind: "added", origin: "app" };
const modified: Change = { path: "README.md", kind: "modified", origin: "outside" };
const deleted: Change = { path: "docs/old.md", kind: "deleted", origin: "outside" };

describe("changes helpers", () => {
  it("rejectPrompt asks to delete a single added file", () => {
    expect(rejectPrompt([added])).toEqual({ key: "changes.reject.delete", vars: { path: "notes/new.md" } });
  });

  it("rejectPrompt uses the discard wording otherwise", () => {
    expect(rejectPrompt([modified])).toEqual({ key: "changes.reject.discardOne", vars: { path: "README.md" } });
    expect(rejectPrompt([deleted])).toMatchObject({ key: "changes.reject.discardOne" });
    expect(rejectPrompt([added, modified, deleted])).toEqual({ key: "changes.reject.discardMany", vars: { count: 3 } });
  });

  it("every rejectPrompt key is translated", () => {
    for (const changes of [[added], [modified], [added, modified]]) {
      expect(en).toHaveProperty(rejectPrompt(changes).key);
    }
  });

  it("sortChanges sorts by path without touching the input", () => {
    const input = [added, modified, deleted];
    expect(sortChanges(input).map((c) => c.path)).toEqual(["README.md", "docs/old.md", "notes/new.md"]);
    expect(input[0]).toBe(added);
  });

  it("countLabel caps long counts", () => {
    expect(countLabel(0)).toBe("0");
    expect(countLabel(99)).toBe("99");
    expect(countLabel(100)).toBe("99+");
  });
});
