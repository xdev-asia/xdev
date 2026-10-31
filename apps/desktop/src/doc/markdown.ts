// Docs are often written by AI agents and the WebView can call Rust, so the preview must stay inert:
// raw HTML is escaped (`html: false`), markdown-it's default `validateLink` drops `javascript:` and
// similar URLs, no rendered link keeps a real `href`, and images are never fetched.
import MarkdownIt from "markdown-it";
import { type Link, mdTarget, type Resolve, wikiTarget } from "./links";

type RuleInline = Parameters<MarkdownIt["inline"]["ruler"]["before"]>[2];
type StateInline = Parameters<RuleInline>[0];
type RenderRule = NonNullable<MarkdownIt["renderer"]["rules"]["link_open"]>;
type Env = { from: string; resolve: Resolve };

const OPEN = 0x5b; // [
const BANG = 0x21; // !

// `[[target|label]]` and `![[target]]`; an embed is shown as a plain link in M1b.
const wikiLink: RuleInline = (state: StateInline, silent: boolean) => {
  const embed = state.src.charCodeAt(state.pos) === BANG;
  const start = state.pos + (embed ? 1 : 0);
  if (state.src.charCodeAt(start) !== OPEN || state.src.charCodeAt(start + 1) !== OPEN) return false;
  const close = state.src.indexOf("]]", start + 2);
  if (close === -1 || close + 2 > state.posMax) return false;
  const inner = state.src.slice(start + 2, close);
  const target = wikiTarget(inner);
  if (target === null || inner.includes("\n")) return false;
  if (!silent) {
    const bar = inner.indexOf("|");
    const label = bar === -1 ? "" : inner.slice(bar + 1).trim();
    const open = state.push("link_open", "a", 1);
    open.meta = { wiki: target };
    state.push("text", "", 0).content = label || inner.slice(0, bar === -1 ? undefined : bar).trim();
    state.push("link_close", "a", -1);
  }
  state.pos = close + 2;
  return true;
};

function linkAttrs(token: Parameters<RenderRule>[0][number], env: Env): [string, string][] {
  const wiki = (token.meta as { wiki?: string } | null)?.wiki;
  const href = token.attrGet("href") ?? "";
  const target = wiki ?? mdTarget(href);
  if (target === null) return [["data-external", ""], ["title", href]];
  const link: Link = { kind: wiki === undefined ? "md" : "wiki", target };
  const path = env.resolve(link, env.from);
  // `href="#"` keeps the link focusable; the click handler opens the doc.
  return path === null ? [["data-broken", ""]] : [["href", "#"], ["data-doc", path]];
}

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
md.inline.ruler.before("link", "wiki_link", wikiLink);

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrs = linkAttrs(tokens[idx], env as Env);
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const alt = self.renderInlineAsText(tokens[idx].children ?? [], options, env);
  return `<span class="md-image" title="${md.utils.escapeHtml(tokens[idx].attrGet("src") ?? "")}">${md.utils.escapeHtml(alt)}</span>`;
};

/** HTML for a doc body (frontmatter already removed); links point at vault paths via `data-doc`. */
export function renderMarkdown(body: string, from: string, resolve: Resolve): string {
  const env: Env = { from, resolve };
  return md.render(body, env);
}
