import { describe, expect, it } from "vitest";
import { createResolver } from "./links";
import { renderMarkdown } from "./markdown";

const resolve = createResolver(["README.md", "arch/store.md", "notes/plan.md", "notes/sub/deep.md"]);
const render = (body: string, from = "README.md") => renderMarkdown(body, from, resolve);

describe("renderMarkdown", () => {
  it("wiki links to a doc carry data-doc", () => {
    const html = render("See [[store]].");
    expect(html).toContain('data-doc="arch/store.md"');
    expect(html).toContain(">store</a>");
  });

  it("wiki labels, anchors and embeds", () => {
    expect(render("[[store#Why|the store]]")).toMatch(/<a [^>]*data-doc="arch\/store.md"[^>]*>the store<\/a>/);
    expect(render("![[store]]")).toContain('data-doc="arch/store.md"');
  });

  it("missing targets are marked broken", () => {
    const html = render("[[nope]] and [gone](gone.md)");
    expect(html.match(/data-broken/g)).toHaveLength(2);
    expect(html).not.toContain("data-doc");
  });

  it("markdown links resolve like links.ts", () => {
    expect(render("[x](../plan.md)", "notes/sub/deep.md")).toContain('data-doc="notes/plan.md"');
    expect(render("[x](/arch/store.md#why)", "notes/sub/deep.md")).toContain('data-doc="arch/store.md"');
  });

  it("no link keeps a real href", () => {
    for (const html of [render("[[store]]"), render("[a](https://x.dev)"), render("<https://x.dev>"), render("[x](../plan.md)")]) {
      expect(html).not.toMatch(/href="(?!#")/);
    }
  });

  it("external links show their URL on hover only", () => {
    const html = render("[site](https://x.dev/a?b=1&c=2)");
    expect(html).toContain("data-external");
    expect(html).toContain('title="https://x.dev/a?b=1&amp;c=2"');
  });

  it("wiki links in code stay literal", () => {
    const html = render("```\n[[store]]\n```\n\nInline `[[store]]` here.");
    expect(html).not.toContain("data-doc");
    expect(html.match(/\[\[store\]\]/g)).toHaveLength(2);
  });

  it("a wiki link inside link text does not nest links", () => {
    const html = render("[see [[store]]](../plan.md)", "notes/sub/deep.md");
    // markdown-it gives up on the outer link (its label holds a link), so only the wiki link remains.
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('data-doc="arch/store.md"');
  });

  it("wiki text is escaped", () => {
    const html = render('[[<b onclick="x">|<i>]]');
    expect(html).not.toContain("<b ");
    expect(html).not.toContain("<i>");
  });

  it("preview_escapes_html_and_script_links", () => {
    const html = render(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n[y](JAVASCRIPT:alert(1))\n\n<javascript:alert(1)>",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html.toLowerCase()).not.toContain('href="javascript:');
    expect(html).not.toMatch(/<[^>]* on\w+=/);
  });

  it("images are not loaded", () => {
    const html = render("![a cat](https://x.dev/cat.png) ![](local.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("a cat");
  });
});
