import { javascript } from "@codemirror/lang-javascript";
import { describe, expect, it } from "vitest";
import { renderRich } from "./markdownRich";

const resolve = () => null;
const render = (src: string, extra = {}) => renderRich(src, { rel: "a.md", resolve, ...extra });

describe("renderRich", () => {
  it("renders GFM tables and strikethrough", () => {
    const { html } = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~");
    expect(html).toContain("<table>");
    expect(html).toContain("<s>gone</s>");
  });

  it("renders task lists as disabled checkboxes", () => {
    const { html } = render("- [ ] todo\n- [x] done");
    expect(html.match(/type="checkbox" disabled/g)).toHaveLength(2);
    expect(html).toContain("disabled checked");
    expect(html).toContain("md-task-item");
    expect(html).toContain("todo");
    expect(html).not.toContain("[ ]");
  });

  it.each([
    ["NOTE", "note", "Note"],
    ["TIP", "tip", "Tip"],
    ["IMPORTANT", "important", "Important"],
    ["WARNING", "warning", "Warning"],
    ["CAUTION", "caution", "Caution"],
  ])("renders a %s callout with its title", (marker, kind, title) => {
    const { html } = render(`> [!${marker}]\n> body text`);
    expect(html).toContain(`md-callout md-callout-${kind}`);
    expect(html).toContain(`<p class="md-callout-title">${title}</p>`);
    expect(html).toContain("body text");
    expect(html).not.toContain("[!");
  });

  it("takes translated callout titles and keeps a plain blockquote plain", () => {
    expect(render("> [!TIP]\n> x", { labels: { callouts: { tip: "Mẹo" } } }).html).toContain("Mẹo");
    expect(render("> quote").html).not.toContain("md-callout");
  });

  it("gives headings deduped slug ids and lists them", () => {
    const { html, headings } = render("# Intro\n## Intro\n## Intro\n### Hello, World!");
    expect(headings).toEqual([
      { level: 1, text: "Intro", id: "intro" },
      { level: 2, text: "Intro", id: "intro-1" },
      { level: 2, text: "Intro", id: "intro-2" },
      { level: 3, text: "Hello, World!", id: "hello-world" },
    ]);
    expect(html).toContain('<h2 id="intro-1">');
  });

  it("renders KaTeX inline and as a block", () => {
    expect(render("so $a^2$ here").html).toContain('class="katex"');
    const block = render("$$\nx = 1\n$$").html;
    expect(block).toContain("katex-display");
  });

  it("leaves prices alone and shows the source of bad TeX", () => {
    expect(render("costs $5 and $6").html).not.toContain("katex");
    const bad = render("$\\frac{$").html;
    expect(bad).toContain("md-math-error");
    expect(bad).toContain("\\frac{");
  });

  it("shows front matter as a collapsed raw block", () => {
    const { html } = render("---\ntitle: Hi\n---\n# Body", { labels: { frontmatter: "Front matter" } });
    expect(html).toContain('<details class="md-frontmatter"><summary>Front matter</summary>');
    expect(html).toContain("title: Hi");
    expect(html).toContain("<h1");
  });

  it("highlights a fence with tok-* classes when a parser is given, and stays plain without one", () => {
    const src = "```ts\nconst x: number = 1;\n```";
    const parsers = { ts: javascript({ typescript: true }).language.parser };
    expect(render(src, { parsers }).html).toMatch(/class="tok-keyword"/);
    const plain = render(src).html;
    expect(plain).not.toContain("tok-");
    expect(plain).toContain("const x: number = 1;");
  });

  it("escapes raw HTML", () => {
    const { html } = render("<script>alert(1)</script>\n\nhi <b>x</b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>");
  });

  it("never fetches a remote image", () => {
    const { html } = render("![logo](https://example.com/a.png)");
    expect(html).toContain('class="md-image"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("src=");
  });

  it("emits a placeholder for a mermaid fence", () => {
    const { html } = render("```mermaid\ngraph TD\n  A-->B\n```");
    expect(html).toContain('<div class="md-mermaid" data-src="graph TD');
    expect(html).toContain("A--&gt;B");
  });
});
