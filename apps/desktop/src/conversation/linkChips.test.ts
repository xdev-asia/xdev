import { expect, it } from "vitest";
import { linkChips } from "./linkChips";

it("lists http(s) hosts in order without www", () => {
  const c = linkChips("see https://www.example.com/a/b and http://x.test");
  expect(c.map((x) => x.host)).toEqual(["example.com", "x.test"]);
  expect(c[0]?.url).toBe("https://www.example.com/a/b");
});

it("drops duplicates and caps at 3", () => {
  expect(linkChips("https://a.test https://a.test")).toHaveLength(1);
  const many = linkChips("https://a.test https://b.test https://c.test https://d.test");
  expect(many.map((x) => x.host)).toEqual(["a.test", "b.test", "c.test"]);
});

it("ignores other schemes and bare hosts", () => {
  expect(linkChips("ftp://a.test javascript:alert(1) mailto:a@b.test file:///x example.com")).toEqual([]);
});

it("cuts long paths to 24 characters and shows / as empty", () => {
  const long = linkChips("https://a.test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")[0]!;
  expect(long.path.endsWith("…")).toBe(true);
  expect(long.path.length).toBe(25);
  expect(linkChips("https://a.test/")[0]!.path).toBe("");
});

it("keeps ipv6 hosts and never throws", () => {
  expect(linkChips("https://[::1]:8080/x")[0]!.host).toBe("[::1]");
  expect(() => linkChips("https://exa mple.test http://[bad")).not.toThrow();
});
