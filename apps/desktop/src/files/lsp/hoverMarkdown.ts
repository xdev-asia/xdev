import MarkdownIt from "markdown-it";

// HTML in a server's text is escaped; markdown-it's default link check drops `javascript:` and the like.
const md = new MarkdownIt({ html: false, linkify: true });

/**
 * The DOM of a hover's Markdown. It is parsed in an inert document, so nothing loads: images become
 * their alt text and links lose their `href` (a click must not navigate the window).
 */
export function renderHover(markdown: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<body>${md.render(markdown)}</body>`, "text/html");
  for (const img of [...doc.querySelectorAll("img")]) img.replaceWith(doc.createTextNode(img.getAttribute("alt") ?? ""));
  for (const a of [...doc.querySelectorAll("a")]) a.removeAttribute("href");
  const root = document.createElement("div");
  root.className = "lsp-hover";
  root.append(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
  return root;
}
