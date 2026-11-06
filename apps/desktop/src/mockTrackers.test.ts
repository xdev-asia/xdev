import { expect, it } from "vitest";
import { createMockApi } from "./api";

it("starts with Linear connected as Ada, Jira not, GitHub on defaults", async () => {
  const v = await createMockApi({}).trackersStatus();
  expect(v.linear).toMatchObject({ connected: true, account: "Ada" });
  expect(v.jira.connected).toBe(false);
  expect(v.github).toEqual({ assigned: true, created: false, done: false });
});

it("connects Jira Cloud, and refuses an empty token or a non-site URL", async () => {
  const api = createMockApi({});
  const v = await api.trackerConnect({ kind: "jiraCloud", url: "acme", email: "a@x.io", token: "t" });
  expect(v.jira).toMatchObject({ connected: true, mode: "cloud", base: "https://acme.atlassian.net", email: "a@x.io" });
  await expect(api.trackerConnect({ kind: "jiraCloud", url: "acme", email: "a@x.io", token: "" })).rejects.toMatchObject({ code: "empty_key" });
  await expect(api.trackerConnect({ kind: "jiraCloud", url: "http://x", email: "a@x.io", token: "t" })).rejects.toMatchObject({
    code: "tracker_bad_url",
  });
});

it("lists three Linear items and refuses Jira while it is not connected", async () => {
  const api = createMockApi({});
  const list = await api.trackerList("linear");
  expect(list.items.map((i) => i.stateKind)).toEqual(["inProgress", "done", "todo"]);
  expect(list.items.some((i) => i.assignee === null)).toBe(true);
  await expect(api.trackerList("jira")).rejects.toMatchObject({ code: "tracker_not_configured" });
});

it("disconnects and keeps at least one who-box on", async () => {
  const api = createMockApi({});
  expect((await api.trackerDisconnect("linear")).linear.connected).toBe(false);
  const v = await api.trackerPullsSet("github", { assigned: false, created: false, done: true });
  expect(v.github).toEqual({ assigned: true, created: false, done: true });
});
