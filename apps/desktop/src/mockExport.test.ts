import { describe, expect, it } from "vitest";
import { estimateTokens, EXPORT_MARKER, exportStatus, renderExport } from "./mockExport";

// Same cases as `render_golden` and friends in `xdev-export`, which is the truth.
describe("mock export rendering", () => {
  const a = {
    source: "docs/a.md",
    title: "A",
    targets: ["agents" as const],
    body: "# A\n\nIntro\n\n## Part\n\n```\n# not a heading\n```\n",
  };
  const b = { source: "docs/b.md", title: "B", targets: ["claude" as const], body: "Claude only" };

  it("renders the golden files", () => {
    expect(renderExport([b, a])).toEqual([
      {
        path: "AGENTS.md",
        content: `${EXPORT_MARKER}\n# Agent guide\n\n## A\n_Source: \`docs/a.md\`_\n\nIntro\n\n### Part\n\n\`\`\`\n# not a heading\n\`\`\`\n`,
      },
      {
        path: "CLAUDE.md",
        content: `${EXPORT_MARKER}\n# Claude Code guide\n\n@AGENTS.md\n\n## B\n_Source: \`docs/b.md\`_\n\nClaude only\n`,
      },
      { path: "GEMINI.md", content: `${EXPORT_MARKER}\n# Gemini guide\n\n@AGENTS.md\n` },
    ]);
  });

  it("renders nothing without targets, and a lone Cursor rule", () => {
    expect(renderExport([{ ...a, targets: [] }])).toEqual([]);
    const cursor = renderExport([{ ...b, targets: ["cursor"] }]);
    expect(cursor.map((f) => f.path)).toEqual([".cursor/rules/xdev.mdc"]);
    expect(cursor[0].content.startsWith("---\n")).toBe(true);
  });

  it("an empty body leaves only the source line, and ###### stays", () => {
    const [agents] = renderExport([{ ...a, body: "# Only title\r\n" }, { ...a, source: "z.md", body: "###### Six\n" }]);
    expect(agents.content).toBe(
      `${EXPORT_MARKER}\n# Agent guide\n\n## A\n_Source: \`docs/a.md\`_\n\n## A\n_Source: \`z.md\`_\n\n###### Six\n`,
    );
  });

  it("statuses", () => {
    expect(exportStatus(null, "x")).toBe("new");
    expect(exportStatus("# mine\n", "x")).toBe("foreign");
    expect(exportStatus(`a\nb\nc\nd\n${EXPORT_MARKER}\n`, "x")).toBe("changed");
    expect(exportStatus(`a\nb\nc\nd\ne\n${EXPORT_MARKER}\n`, "x")).toBe("foreign");
    expect(exportStatus("same", "same")).toBe("foreign");
    expect(exportStatus(`${EXPORT_MARKER}\n`, `${EXPORT_MARKER}\n`)).toBe("unchanged");
  });

  it("estimates tokens", () => {
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});
