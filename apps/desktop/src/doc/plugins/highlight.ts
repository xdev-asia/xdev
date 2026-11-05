import type { Language as CmLanguage } from "@codemirror/language";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import type MarkdownIt from "markdown-it";
import type { Language } from "@/files/languages";

/** The parsers a render may use, by language; a missing one leaves the code plain. */
export type Parsers = Partial<Record<Language, CmLanguage["parser"]>>;

const ALIAS: Record<string, Language> = {
  js: "js", jsx: "js", javascript: "js", mjs: "js", cjs: "js",
  ts: "ts", tsx: "ts", typescript: "ts",
  rust: "rust", rs: "rust",
  json: "json", jsonc: "json",
  css: "css",
  html: "html", htm: "html",
  python: "python", py: "python",
  yaml: "yaml", yml: "yaml",
  markdown: "markdown", md: "markdown",
};

/** The language a fence names (`ts`, `rust`, …); null for none or an unknown one. */
export function fenceLanguage(info: string): Language | null {
  return ALIAS[info.trim().split(/\s+/)[0].toLowerCase()] ?? null;
}

/** Fenced code gets `tok-*` classes where a parser is given. `env.parsers` holds them. */
export function highlightPlugin(md: MarkdownIt): void {
  const esc = md.utils.escapeHtml;
  md.renderer.rules.fence = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    const name = token.info.trim().split(/\s+/)[0].toLowerCase();
    const lang = fenceLanguage(token.info);
    const parser = lang ? (env as { parsers?: Parsers }).parsers?.[lang] : undefined;
    let html = esc(token.content);
    if (parser) {
      html = "";
      highlightCode(
        token.content,
        parser.parse(token.content),
        classHighlighter,
        (text, classes) => (html += classes ? `<span class="${classes}">${esc(text)}</span>` : esc(text)),
        () => (html += "\n"),
      );
    }
    const cls = name ? ` class="language-${esc(name)}"` : "";
    return `<pre class="md-code"><code${cls}>${html}</code></pre>\n`;
  };
}
