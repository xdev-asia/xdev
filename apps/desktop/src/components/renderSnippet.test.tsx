import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { renderSnippet } from "./renderSnippet";

function marks(nodes: ReactNode[]): ReactElement<{ children: string }>[] {
  return nodes.filter((n): n is ReactElement<{ children: string }> => isValidElement(n));
}

function plainText(nodes: ReactNode[]): string {
  return nodes.filter((n) => typeof n === "string").join("");
}

describe("renderSnippet", () => {
  it("renderSnippet keeps tags as text", () => {
    const nodes = renderSnippet("&lt;img onerror=x&gt; <mark>a</mark>");
    expect(plainText(nodes)).toBe("<img onerror=x> ");
    const found = marks(nodes);
    expect(found).toHaveLength(1);
    expect(found[0].type).toBe("mark");
    expect(found[0].props.children).toBe("a");
  });

  it("decodes every escaped entity once", () => {
    expect(plainText(renderSnippet("&amp;lt; &quot;q&quot; &#39;s&#39; a&amp;b"))).toBe("&lt; \"q\" 's' a&b");
  });

  it("raw tags other than mark stay text", () => {
    const nodes = renderSnippet("<b>x</b><mark><i>y</i></mark>");
    expect(plainText(nodes)).toBe("<b>x</b>");
    expect(marks(nodes)[0].props.children).toBe("<i>y</i>");
  });

  it("handles several marks and an unclosed one", () => {
    const nodes = renderSnippet("<mark>a</mark> and <mark>b</mark> and <mark>c");
    expect(marks(nodes).map((m) => m.props.children)).toEqual(["a", "b", "c"]);
    expect(plainText(nodes)).toBe(" and  and ");
  });

  it("gives marks distinct keys", () => {
    const keys = marks(renderSnippet("<mark>a</mark><mark>b</mark>")).map((m) => m.key);
    expect(new Set(keys).size).toBe(2);
  });
});
