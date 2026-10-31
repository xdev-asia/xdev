import { describe, expect, it } from "vitest";
import fixtures from "../../../../fixtures/links.json";
import { createResolver, mdTarget, parseLinks, wikiTarget } from "./links";

describe("link fixtures", () => {
  const resolve = createResolver(fixtures.docs);
  for (const c of fixtures.cases) {
    it(c.name, () => {
      const links = parseLinks(c.content);
      expect(links.map((l) => ({ kind: l.kind, target: l.target }))).toEqual(
        c.links.map((l) => ({ kind: l.kind, target: l.target })),
      );
      expect(links.map((l) => resolve(l, c.from))).toEqual(c.links.map((l) => l.resolved));
    });
  }
});

describe("link helpers", () => {
  it("wikiTarget drops label and anchor", () => {
    expect(wikiTarget(" a/b#x|y ")).toBe("a/b");
    expect(wikiTarget("|label")).toBeNull();
  });

  it("mdTarget skips what is not a doc link", () => {
    expect(mdTarget("a%20b.md?x#y")).toBe("a b.md");
    expect(mdTarget("<my doc.md>")).toBe("my doc.md");
    expect(mdTarget("javascript:alert(1)")).toBeNull();
    expect(mdTarget("bad%zz.md")).toBe("bad%zz.md");
    expect(mdTarget("")).toBeNull();
  });

  it("unclosed backticks are literal", () => {
    expect(parseLinks("a ` [[README]]").map((l) => l.target)).toEqual(["README"]);
    expect(parseLinks("``x ` [[a]]`` [[b]]").map((l) => l.target)).toEqual(["b"]);
  });

  it("a fence closes only with its own marker", () => {
    expect(parseLinks("```\n~~~\n[[a]]\n```\n[[b]]\n").map((l) => l.target)).toEqual(["b"]);
  });
});
