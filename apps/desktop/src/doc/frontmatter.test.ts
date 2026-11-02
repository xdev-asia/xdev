import { describe, expect, it } from "vitest";
import fixtures from "../../../../fixtures/frontmatter.json";
import { agentsEditable, extractTitle, parseFrontmatter, setAgents, setVerified } from "./frontmatter";

// Cases leave out the newer keys when they hold their default.
type NewKeys = { covers?: string[]; verified?: string | null; type?: string | null };

describe("frontmatter fixtures", () => {
  for (const c of fixtures.cases) {
    it(c.name, () => {
      const { fm, body } = parseFrontmatter(c.input);
      expect(body, "body").toBe(c.body);
      expect(extractTitle(fixtures.path, c.input), "title").toBe(c.title);
      expect(fm.agents, "agents").toEqual(c.agents);
      expect(fm.tags, "tags").toEqual(c.tags);
      const more = c as NewKeys;
      expect(fm.covers, "covers").toEqual(more.covers ?? []);
      expect(fm.verified, "verified").toBe(more.verified ?? null);
      expect(fm.type, "type").toBe(more.type ?? null);
    });
  }
});

describe("parseFrontmatter", () => {
  it("returns the raw block text, or null without one", () => {
    expect(parseFrontmatter("---\ntitle: A\n---\nbody").raw).toBe("title: A\n");
    expect(parseFrontmatter("# no block\n").raw).toBeNull();
  });
});

describe("extractTitle", () => {
  it("falls back to the stem", () => {
    expect(extractTitle("docs/a.b.md", "")).toBe("a.b");
    expect(extractTitle("README", "text")).toBe("README");
  });
});

describe("setAgents", () => {
  it("creates a block when there is none", () => {
    expect(setAgents("# Doc\n", true)).toBe("---\nagents: true\n---\n# Doc\n");
  });

  it("keeps a BOM and CRLF line endings", () => {
    expect(setAgents("﻿# Doc\r\n", true)).toBe("﻿---\r\nagents: true\r\n---\r\n# Doc\r\n");
    expect(setAgents("---\r\ntitle: T\r\n---\r\nx", true)).toBe("---\r\ntitle: T\r\nagents: true\r\n---\r\nx");
  });

  it("adds the key to an existing block and keeps the other lines", () => {
    const doc = "---\ntitle: Store\ntags: [a]\n---\n# H\n";
    expect(setAgents(doc, true)).toBe("---\ntitle: Store\ntags: [a]\nagents: true\n---\n# H\n");
    expect(setAgents("---\ntitle: T\n---", true)).toBe("---\ntitle: T\nagents: true\n---");
  });

  it("turns agents: false into true", () => {
    expect(setAgents("---\nagents: false # off\ntitle: T\n---\n", true)).toBe("---\nagents: true\ntitle: T\n---\n");
  });

  it("is unchanged when already on", () => {
    const doc = "---\nagents: true\n---\nx";
    expect(setAgents(doc, true)).toBe(doc);
  });

  it("off removes the line and keeps the block when it still has content", () => {
    expect(setAgents("---\ntitle: T\nagents: true\n---\nx", false)).toBe("---\ntitle: T\n---\nx");
  });

  it("off drops a block that becomes empty", () => {
    expect(setAgents("---\nagents: true\n---\n# H\n", false)).toBe("# H\n");
    expect(setAgents("﻿---\r\nagents: true\r\n\r\n---\r\n# H\r\n", false)).toBe("﻿# H\r\n");
  });

  it("off without the key is unchanged", () => {
    expect(setAgents("# H\n", false)).toBe("# H\n");
    expect(setAgents("---\ntitle: T\n---\n", false)).toBe("---\ntitle: T\n---\n");
  });

  it("leaves a list of agents alone, the caller disables the checkbox", () => {
    for (const doc of ["---\nagents: [claude]\n---\n", "---\nagents: claude\n---\n", "---\nagents:\n  - cursor\n---\n"]) {
      expect(agentsEditable(doc)).toBe(false);
      expect(setAgents(doc, true)).toBe(doc);
      expect(setAgents(doc, false)).toBe(doc);
    }
  });

  it("agentsEditable for a missing key or a boolean", () => {
    expect(agentsEditable("# H")).toBe(true);
    expect(agentsEditable("---\ntitle: T\n---\n")).toBe(true);
    expect(agentsEditable("---\nagents: true\n---\n")).toBe(true);
    expect(agentsEditable("---\nagents: false\n---\n")).toBe(true);
  });

  it("round-trips through the parser", () => {
    const on = setAgents("---\ntitle: T\n---\n# H\n", true);
    expect(parseFrontmatter(on).fm).toEqual({
      title: "T",
      agents: ["agents"],
      tags: [],
      covers: [],
      verified: null,
      type: null,
    });
    expect(parseFrontmatter(setAgents(on, false)).fm.agents).toEqual([]);
  });
});

describe("setVerified", () => {
  const id = "3f2a9c1d00000000000000000000000000000000";

  it("adds a block when there is none", () => {
    expect(setVerified("# Doc\n", id)).toBe(`---\nverified: ${id}\n---\n# Doc\n`);
    expect(setVerified("﻿# Doc\r\n", id)).toBe(`﻿---\r\nverified: ${id}\r\n---\r\n# Doc\r\n`);
  });

  it("replaces an existing verified and keeps its line ending", () => {
    expect(setVerified("---\nverified: abc1234 # old\ncovers: src\n---\nx", id)).toBe(
      `---\nverified: ${id}\ncovers: src\n---\nx`,
    );
    expect(setVerified('---\r\nverified: "nope"\r\n---\r\n# H\r\n', id)).toBe(`---\r\nverified: ${id}\r\n---\r\n# H\r\n`);
  });

  it("replaces the last of repeated keys, the one the parser reads", () => {
    const out = setVerified("---\nverified: aaaa\nverified: bbbb\n---\n", id);
    expect(out).toBe(`---\nverified: aaaa\nverified: ${id}\n---\n`);
    expect(parseFrontmatter(out).fm.verified).toBe(id);
  });

  it("keeps CRLF when adding to an existing block", () => {
    expect(setVerified("---\r\ntitle: T\r\n---\r\nbody\r\n", id)).toBe(`---\r\ntitle: T\r\nverified: ${id}\r\n---\r\nbody\r\n`);
    expect(setVerified("---\ntitle: T\n---", id)).toBe(`---\ntitle: T\nverified: ${id}\n---`);
  });

  it("leaves other keys, comments, odd lines and the body untouched", () => {
    const doc = [
      "---",
      "# who owns this",
      "title: 'Store: design'",
      "covers:",
      "  - crates/xdev-store/**",
      "not a pair",
      "type: adr # decision",
      "---",
      "# Store",
      "",
      "verified: in the body is not frontmatter",
      "",
    ].join("\n");
    const out = setVerified(doc, id);
    expect(out).toBe(doc.replace("type: adr # decision\n---", `type: adr # decision\nverified: ${id}\n---`));
    const { fm, body } = parseFrontmatter(out);
    expect(fm).toMatchObject({ title: "Store: design", covers: ["crates/xdev-store/**"], verified: id, type: "adr" });
    expect(body).toBe(parseFrontmatter(doc).body);
  });
});
