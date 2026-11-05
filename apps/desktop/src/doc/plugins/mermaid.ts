import type MarkdownIt from "markdown-it";

/** A ```mermaid fence becomes a placeholder; the preview draws it after mount. */
export function mermaidPlugin(md: MarkdownIt): void {
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.info.trim().split(/\s+/)[0].toLowerCase() !== "mermaid") return fence(tokens, idx, options, env, self);
    return `<div class="md-mermaid" data-src="${md.utils.escapeHtml(token.content)}"></div>\n`;
  };
}
