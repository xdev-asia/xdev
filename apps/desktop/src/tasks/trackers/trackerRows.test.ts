import { expect, it } from "vitest";
import type { Issue } from "@/api";
import { githubQueries, githubRows, loadShown, mergeGithub, saveShown, stateTone } from "./trackerRows";

const issue = (n: number, patch: Partial<Issue> = {}): Issue => ({
  number: n,
  url: `https://github.com/example/demo/issues/${n}`,
  state: "open",
  title: `Issue ${n}`,
  labels: [],
  assignees: [],
  author: null,
  updatedAt: `2026-11-0${n}T00:00:00Z`,
  ...patch,
});

it("maps GitHub issues to rows: #12, closed is done", () => {
  const [open, closed] = githubRows([issue(1, { assignees: ["ada"] }), issue(2, { state: "closed" })]);
  expect(open).toMatchObject({ source: "github", id: "1", key: "#1", state: "Open", stateKind: "todo", assignee: "ada" });
  expect(closed).toMatchObject({ state: "Closed", stateKind: "done", assignee: null });
});

it("asks one query per box that is on", () => {
  const q = githubQueries({ assigned: true, created: true });
  expect(q).toHaveLength(2);
  expect(q[0]).toMatchObject({ assigneeMe: true, limit: 50 });
  expect(q[1]).toMatchObject({ search: "author:@me", limit: 50 });
  expect(githubQueries({ assigned: true, created: false })).toHaveLength(1);
});

it("merges by number and sorts newest first", () => {
  const merged = mergeGithub([[issue(1), issue(3)], [issue(3), issue(2)]]);
  expect(merged.map((i) => i.number)).toEqual([3, 2, 1]);
});

it("tones the status dot", () => {
  expect(stateTone("todo")).toBe("neutral");
  expect(stateTone("inProgress")).toBe("accent");
  expect(stateTone("done")).toBe("ok");
  expect(stateTone("canceled")).toBe("neutral");
});

it("loads all shown by default, from bad JSON and from a throwing store", () => {
  const all = { github: true, linear: true, jira: true };
  expect(loadShown({ getItem: () => null })).toEqual(all);
  expect(loadShown({ getItem: () => "{nope" })).toEqual(all);
  expect(loadShown({ getItem: () => "7" })).toEqual(all);
  expect(
    loadShown({
      getItem: () => {
        throw new Error("denied");
      },
    }),
  ).toEqual(all);
  expect(loadShown({ getItem: () => '{"linear":false}' })).toEqual({ github: true, linear: false, jira: true });
});

it("saves without throwing when the store does", () => {
  const set: string[] = [];
  saveShown({ github: true, linear: false, jira: true }, { setItem: (_k, v) => void set.push(v) });
  expect(JSON.parse(set[0])).toEqual({ github: true, linear: false, jira: true });
  expect(() =>
    saveShown(
      { github: true, linear: true, jira: true },
      {
        setItem: () => {
          throw new Error("full");
        },
      },
    ),
  ).not.toThrow();
});
