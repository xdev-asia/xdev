import { expect, it } from "vitest";
import type { IssueEvent } from "@/api";
import { translate } from "@/i18n";
import { timelineLine } from "./issueTimeline";

const at = "2026-11-03T12:00:00Z";

it("maps every event kind to an existing key in both languages", () => {
  const kinds: IssueEvent["kind"][] = ["assigned", "unassigned", "closed", "reopened", "labeled", "unlabeled", "renamed", "cross_referenced"];
  for (const kind of kinds) {
    const { key } = timelineLine({ kind, actor: "a", subject: "s", createdAt: at }, "ghost");
    for (const locale of ["en", "vi"] as const) expect(translate(locale, key)).not.toBe(key);
  }
});

it("fills the actor and subject, with a ghost for a missing actor", () => {
  expect(timelineLine({ kind: "labeled", actor: "octo", subject: "bug", createdAt: at }, "Unknown user")).toEqual({
    key: "issues.timeline.labeled",
    vars: { actor: "octo", subject: "bug" },
  });
  expect(timelineLine({ kind: "closed", actor: null, subject: null, createdAt: at }, "Unknown user").vars).toEqual({ actor: "Unknown user", subject: "" });
  expect(timelineLine({ kind: "cross_referenced", actor: "a", subject: "#7 Fix", createdAt: at }, "g").key).toBe("issues.timeline.crossReferenced");
});
