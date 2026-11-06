import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { vi } from "vitest";
import { task } from "./fixtures";
import { sortTasks, TaskList } from "./TaskList";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const rows = [
  task("a", { title: "Banana", priority: "p2", updated: "2026-11-01T00:00:00Z", status: "done" }),
  task("b", { title: "Apple", priority: "p0", updated: "2026-11-01T00:00:00Z", status: "backlog" }),
  task("c", { title: "Cherry", priority: "p2", updated: "2026-11-03T00:00:00Z", status: "todo" }),
];
const order = (sort: Parameters<typeof sortTasks>[1]) => sortTasks(rows, sort).map((t) => t.id);

it("by default sorts by priority, then the newest update", () => expect(order(null)).toEqual(["b", "c", "a"]));
it("a header sorts by that column, in both directions", () => {
  expect(order({ key: "title", dir: "asc" })).toEqual(["b", "a", "c"]);
  expect(order({ key: "title", dir: "desc" })).toEqual(["c", "a", "b"]);
  expect(order({ key: "priority", dir: "desc" })).toEqual(["c", "a", "b"]);
  expect(order({ key: "status", dir: "asc" })).toEqual(["b", "c", "a"]);
  expect(order({ key: "updated", dir: "desc" })).toEqual(["c", "b", "a"]);
});
it("draws a row per task in the default order, with sortable headers", () => {
  const html = renderToStaticMarkup(<TaskList tasks={rows} total={3} agentName={(x) => x} onOpen={() => {}} onNew={() => {}} onClearFilters={() => {}} />);
  expect(html.indexOf("Apple")).toBeLessThan(html.indexOf("Cherry"));
  expect(html.indexOf("Cherry")).toBeLessThan(html.indexOf("Banana"));
  expect(html).toContain("x-table-sort");
});
it("with filters hiding everything it says so and offers Clear filters", () => {
  const html = renderToStaticMarkup(<TaskList tasks={[]} total={3} agentName={(x) => x} onOpen={() => {}} onNew={() => {}} onClearFilters={() => {}} />);
  expect(html).toContain("No tasks match these filters");
  expect(html).toContain("Clear filters");
});
