import type MarkdownIt from "markdown-it";

export type Heading = { level: number; text: string; id: string };

/** A GitHub-style anchor: lower case, punctuation dropped, spaces to `-`. */
export function slugOf(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Gives every heading an `id` (deduped with `-1`, `-2`) and lists them in `env.headings`. */
export function slugPlugin(md: MarkdownIt): void {
  md.core.ruler.push("heading_slugs", (state) => {
    const headings: Heading[] = [];
    const seen = new Map<string, number>();
    state.tokens.forEach((token, i) => {
      if (token.type !== "heading_open") return;
      const inline = state.tokens[i + 1];
      const text = (inline.children ?? []).map((c) => (c.type === "text" || c.type === "code_inline" ? c.content : "")).join("");
      const base = slugOf(text) || "section";
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const id = n === 0 ? base : `${base}-${n}`;
      token.attrSet("id", id);
      headings.push({ level: Number(token.tag.slice(1)), text, id });
    });
    (state.env as { headings?: Heading[] }).headings = headings;
  });
}
