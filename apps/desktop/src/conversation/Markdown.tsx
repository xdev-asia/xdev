// Agent text as Markdown, built as React elements from markdown-it tokens: nothing goes through
// innerHTML, raw HTML stays text, images are never fetched and links open a menu instead of navigating.
// File paths in the text become chips.
import MarkdownIt from "markdown-it";
import { CodeBlock } from "@xdev-asia/ui";
import { createContext, Fragment, useContext, useMemo } from "react";
import type { JSX, MouseEvent, ReactNode } from "react";
import { findFileLinks, type FileLink } from "@/terminal/fileLinks";

type Token = ReturnType<MarkdownIt["parse"]>[number];

/** What a rendered message needs from the view: path lookups and the actions of chips and links. */
export interface MarkdownEnv {
  /** A path as printed to its worktree-relative file, `null` when it names none, absent while unknown. */
  resolved(path: string): string | null | undefined;
  onPath(link: { path: string; rel: string | null; line?: number; column?: number }): void;
  /** `from` is the link's button, to take focus back when the menu closes. */
  onLink(url: string, at: { x: number; y: number }, from: HTMLElement): void;
  label: {
    open(path: string): string;
    copy(path: string): string;
    code: { copy: string; copied: string };
  };
}

export const MarkdownContext = createContext<MarkdownEnv | null>(null);

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: true });
// Only links with a scheme: `README.md` is a file, not a site.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

/** The path candidates of `text` worth resolving, without line suffixes, each once. */
export function pathCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) for (const link of findFileLinks(line)) out.add(link.path);
  return [...out];
}

const hasSeparator = (path: string) => /[\\/]/.test(path);

/** How one path candidate shows: an open chip, a copy chip, or plain text (a bare name that names no file). */
export function chipKind(path: string, rel: string | null | undefined): "open" | "copy" | "text" {
  if (rel) return "open";
  return hasSeparator(path) ? "copy" : "text";
}

function PathChip({ link, text, env }: { link: FileLink; text: string; env: MarkdownEnv }): JSX.Element {
  const rel = env.resolved(link.path) ?? null;
  const kind = chipKind(link.path, rel);
  if (kind === "text") return <>{text}</>;
  const label = kind === "open" ? env.label.open(text) : env.label.copy(text);
  return (
    <button
      type="button"
      className="cv-path"
      data-kind={kind}
      aria-label={label}
      title={label}
      onClick={() => env.onPath({ path: link.path, rel, ...(link.line !== undefined ? { line: link.line } : {}), ...(link.column !== undefined ? { column: link.column } : {}) })}
    >
      {text}
    </button>
  );
}

/** `text` with its path candidates as chips. */
function withChips(text: string, env: MarkdownEnv | null, key: string): ReactNode {
  if (!env) return text;
  const links = findFileLinks(text);
  if (links.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  links.forEach((link, i) => {
    if (link.start > at) out.push(text.slice(at, link.start));
    out.push(<PathChip key={`${key}.${i}`} link={link} text={text.slice(link.start, link.end)} env={env} />);
    at = link.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Inline code that is one path whole, as a chip; else plain code. */
function inlineCode(content: string, env: MarkdownEnv | null, key: string): ReactNode {
  const links = env ? findFileLinks(content) : [];
  const whole = links.length === 1 && links[0]!.start === 0 && links[0]!.end === content.length;
  if (env && whole && chipKind(links[0]!.path, env.resolved(links[0]!.path)) !== "text") {
    return <PathChip key={key} link={links[0]!} text={content} env={env} />;
  }
  return <code key={key}>{content}</code>;
}

interface Node {
  token: Token;
  children: Node[];
}

/** The open/close pairs of a flat token list as a tree. */
function tree(tokens: readonly Token[]): Node[] {
  const root: Node[] = [];
  const stack: Node[] = [];
  for (const token of tokens) {
    const into = stack.length > 0 ? stack[stack.length - 1]!.children : root;
    if (token.nesting === 1) {
      const node: Node = { token, children: [] };
      into.push(node);
      stack.push(node);
    } else if (token.nesting === -1) {
      stack.pop();
    } else {
      into.push({ token, children: [] });
    }
  }
  return root;
}

const SAFE_URL = /^https?:\/\//i;
const BLOCK_TAGS = new Set(["p", "ul", "ol", "li", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "strong", "em", "s"]);

function LinkButton({ href, children, env }: { href: string; children: ReactNode; env: MarkdownEnv | null }): JSX.Element {
  if (!env || !SAFE_URL.test(href)) return <>{children}</>;
  const open = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    env.onLink(href, { x: r.left, y: r.bottom }, e.currentTarget);
  };
  return (
    <button type="button" className="cv-link" aria-haspopup="menu" title={href} onClick={open}>
      {children}
    </button>
  );
}

function render(nodes: readonly Node[], env: MarkdownEnv | null, prefix: string, inLink = false): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${prefix}.${i}`;
    const { token } = node;
    switch (token.type) {
      case "inline":
        return <Fragment key={key}>{render(tree(token.children ?? []), env, key, inLink)}</Fragment>;
      case "text":
        return <Fragment key={key}>{inLink ? token.content : withChips(token.content, env, key)}</Fragment>;
      case "code_inline":
        return inLink ? <code key={key}>{token.content}</code> : inlineCode(token.content, env, key);
      case "softbreak":
      case "hardbreak":
        return <br key={key} />;
      case "fence":
      case "code_block": {
        const lang = token.info.trim().split(/\s+/)[0] ?? "";
        const code = token.content.replace(/\n$/, "");
        return <CodeBlock key={key} className="cv-code" code={code} language={lang || undefined} labels={env?.label.code} />;
      }
      case "image":
        return <span key={key}>{token.content}</span>;
      case "hr":
        return <hr key={key} />;
      case "html_block":
      case "html_inline":
        return <span key={key}>{token.content}</span>;
      case "link_open": {
        const href = token.attrGet("href") ?? "";
        return (
          <LinkButton key={key} href={href} env={env}>
            {render(node.children, env, key, true)}
          </LinkButton>
        );
      }
      case "heading_open": {
        // Message headings sit under the view's own headings.
        const level = Math.min(Number(token.tag.slice(1)) + 2, 6);
        const Tag = `h${level}` as "h3";
        return (
          <Tag key={key} className="cv-md-h">
            {render(node.children, env, key, inLink)}
          </Tag>
        );
      }
      case "paragraph_open":
        // A tight list hides its paragraphs.
        return token.hidden ? <Fragment key={key}>{render(node.children, env, key, inLink)}</Fragment> : <p key={key}>{render(node.children, env, key, inLink)}</p>;
      case "ordered_list_open": {
        const start = Number(token.attrGet("start") ?? 1);
        return (
          <ol key={key} start={start === 1 ? undefined : start}>
            {render(node.children, env, key, inLink)}
          </ol>
        );
      }
      default: {
        if (token.nesting === 1 && BLOCK_TAGS.has(token.tag)) {
          const Tag = token.tag as "p";
          return <Tag key={key}>{render(node.children, env, key, inLink)}</Tag>;
        }
        return <span key={key}>{node.children.length > 0 ? render(node.children, env, key, inLink) : token.content}</span>;
      }
    }
  });
}

/** One message's text as Markdown, chips and link menus from the nearest `MarkdownContext`. */
export function Markdown({ text }: { text: string }): JSX.Element {
  const env = useContext(MarkdownContext);
  const nodes = useMemo(() => tree(md.parse(text, {})), [text]);
  return <div className="cv-md">{render(nodes, env, "m")}</div>;
}

