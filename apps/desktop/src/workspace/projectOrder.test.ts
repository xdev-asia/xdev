import { expect, it } from "vitest";
import type { SidebarItem } from "@/api";
import { orderItems, orderRepos } from "./projectOrder";

const repo = (id: string, ...paths: string[]) => ({ id, worktrees: paths.map((path) => ({ path })) });
const ids = (list: { id: string }[]) => list.map((r) => r.id);

it("puts the repo with the newest output first", () => {
  const list = [repo("a", "/a1"), repo("b", "/b1", "/b2"), repo("c", "/c1")];
  expect(ids(orderRepos(list, { "/a1": 1, "/b1": 2, "/b2": 9, "/c1": 5 }))).toEqual(["b", "c", "a"]);
});

it("keeps repos with no activity in manual order at the end", () => {
  const list = [repo("x", "/x"), repo("a", "/a"), repo("y", "/y"), repo("b", "/b")];
  expect(ids(orderRepos(list, { "/a": 1, "/b": 2, "/y": null }))).toEqual(["b", "a", "x", "y"]);
  expect(ids(orderRepos(list, undefined))).toEqual(["x", "a", "y", "b"]);
});

it("is stable for equal times and does not change its input", () => {
  const list = [repo("a", "/a"), repo("b", "/b")];
  expect(ids(orderRepos(list, { "/a": 5, "/b": 5 }))).toEqual(["a", "b"]);
  orderRepos(list, { "/b": 9 });
  expect(ids(list)).toEqual(["a", "b"]);
});

it("orderItems moves repos between their slots and leaves folders and groups in place", () => {
  const r = (id: string, path: string): SidebarItem => ({ kind: "repo", repo: { ...repo(id, path) } as never, kept: [] });
  const folder = { kind: "folder", folder: { id: "f" } } as unknown as SidebarItem;
  const group = { kind: "group", group: { id: "g" }, items: [r("g1", "/g1"), r("g2", "/g2")] } as unknown as SidebarItem;
  const out = orderItems([r("a", "/a"), folder, r("b", "/b"), group], { "/b": 3, "/g2": 4 });
  expect(out.map((i) => (i.kind === "repo" ? i.repo.id : i.kind === "folder" ? "folder" : "group"))).toEqual(["b", "folder", "a", "group"]);
  const inner = (out[3] as Extract<SidebarItem, { kind: "group" }>).items;
  expect(inner.map((i) => (i.kind === "repo" ? i.repo.id : ""))).toEqual(["g2", "g1"]);
});
