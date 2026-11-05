// The full preview renderer: the inert pipeline of markdown.ts plus GFM, callouts, task lists, math,
// heading slugs and code highlight. Raw HTML stays escaped and images are never fetched.
import { createMarkdown, type Env } from "./markdown";
import { parseFrontmatter } from "./frontmatter";
import type { Resolve } from "./links";
import { calloutsPlugin, type Callout } from "./plugins/callouts";
import { highlightPlugin, type Parsers } from "./plugins/highlight";
import { mathPlugin } from "./plugins/math";
import { mermaidPlugin } from "./plugins/mermaid";
import { slugPlugin, type Heading } from "./plugins/slug";
import { tasksPlugin } from "./plugins/tasks";

export type { Heading } from "./plugins/slug";
export type { Parsers } from "./plugins/highlight";

export interface RichOptions {
  /** Path of the file being rendered, for relative links. */
  rel: string;
  resolve: Resolve;
  /** Parsers for fenced code; a language without one stays plain. */
  parsers?: Parsers;
  /** Translated callout titles and the front matter label. */
  labels?: { callouts?: Partial<Record<Callout, string>>; frontmatter?: string };
}

const md = createMarkdown();
// A relative image keeps its path in `data-src` so the preview can read it through the backend;
// a remote one keeps only the title and is never fetched.
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const src = tokens[idx].attrGet("src") ?? "";
  const alt = self.renderInlineAsText(tokens[idx].children ?? [], options, env);
  const esc = md.utils.escapeHtml;
  const local = src !== "" && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src) && !src.startsWith("//") && !src.startsWith("#");
  return `<span class="md-image" title="${esc(src)}"${local ? ` data-src="${esc(src)}" data-alt="${esc(alt)}"` : ""}>${esc(alt)}</span>`;
};
md.use(slugPlugin).use(calloutsPlugin).use(tasksPlugin).use(mathPlugin).use(highlightPlugin).use(mermaidPlugin);

/** HTML for a whole Markdown file (front matter included) and its headings. */
export function renderRich(content: string, opts: RichOptions): { html: string; headings: Heading[] } {
  const { body, raw } = parseFrontmatter(content);
  const env: Env & { headings?: Heading[]; parsers?: Parsers; callouts?: Partial<Record<Callout, string>> } = {
    from: opts.rel,
    resolve: opts.resolve,
    parsers: opts.parsers,
    callouts: opts.labels?.callouts,
  };
  const main = md.render(body, env);
  const front =
    raw === null
      ? ""
      : `<details class="md-frontmatter"><summary>${md.utils.escapeHtml(opts.labels?.frontmatter ?? "Front matter")}</summary><pre>${md.utils.escapeHtml(raw)}</pre></details>\n`;
  return { html: front + main, headings: env.headings ?? [] };
}
