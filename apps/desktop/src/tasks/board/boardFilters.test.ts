import { expect, it } from "vitest";
import { applyFilters, fromQuery, NO_FILTERS, toQuery, type BoardFilters } from "./boardFilters";
import { task } from "./fixtures";

const tasks = [
  task("ta", { title: "Fix the login loop", status: "todo", priority: "p1", assignee: "claude", labels: ["auth", "bug"] }),
  task("tb", { title: "Polish settings", status: "in-progress", priority: "p2", labels: ["ui"] }),
  task("tc", { title: "Rotate key", status: "done", priority: "p0", assignee: "codex", labels: ["auth"] }),
];
const ids = (f: Partial<BoardFilters>) => applyFilters(tasks, { ...NO_FILTERS, ...f }).map((t) => t.id);

it("no filter keeps every task", () => expect(ids({})).toEqual(["ta", "tb", "tc"]));
it("the search matches the title and the labels, ignoring case", () => {
  expect(ids({ search: "LOGIN" })).toEqual(["ta"]);
  expect(ids({ search: "ui" })).toEqual(["tb"]);
  expect(ids({ search: "  auth " })).toEqual(["ta", "tc"]);
});
it("status, priority, agent and label each filter", () => {
  expect(ids({ status: ["done"] })).toEqual(["tc"]);
  expect(ids({ status: ["done", "todo"] })).toEqual(["ta", "tc"]);
  expect(ids({ priority: ["p2"] })).toEqual(["tb"]);
  expect(ids({ agent: ["claude"] })).toEqual(["ta"]);
  expect(ids({ label: ["auth"] })).toEqual(["ta", "tc"]);
});
it("fields combine with and, values of one field with or", () => {
  expect(ids({ label: ["auth"], status: ["done"] })).toEqual(["tc"]);
  expect(ids({ label: ["auth"], agent: ["claude"], search: "bug" })).toEqual(["ta"]);
  expect(ids({ label: ["ui"], status: ["done"] })).toEqual([]);
});
it("the query round trips", () => {
  const f: BoardFilters = { search: "login loop", status: ["todo", "in-review"], priority: ["p0"], agent: ["claude"], label: ["a,b".replace(",", "-"), "ui"] };
  expect(fromQuery(toQuery(f))).toEqual(f);
  expect(toQuery(NO_FILTERS)).toBe("");
  expect(fromQuery("")).toEqual(NO_FILTERS);
  expect(fromQuery(null)).toEqual(NO_FILTERS);
});
it("a query with unknown statuses or priorities drops them", () => {
  expect(fromQuery("status=todo,nope&priority=p9")).toEqual({ ...NO_FILTERS, status: ["todo"] });
});
