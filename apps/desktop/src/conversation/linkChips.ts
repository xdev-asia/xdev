import MarkdownIt from "markdown-it";

const SAFE_URL = /^https?:\/\//i;
const PATH_MAX = 24;

// The same linkify setup as Markdown.tsx, so a chip appears only where the
// message would render a link.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: true });
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

// linkify-it does not match bracketed IPv6 hosts, so find those separately.
const IPV6_URL = /https?:\/\/\[[0-9a-f:.]+\](?::\d+)?(?:[/?#][^\s<>"')\]]*)?/gi;

export type LinkChip = { url: string; host: string; path: string };

/** Up to `max` distinct http(s) links in `text`, in order of first appearance. */
export function linkChips(text: string, max = 3): LinkChip[] {
  const out: LinkChip[] = [];
  const seen = new Set<string>();
  const found = (md.linkify.match(text) ?? []).map((m) => ({ at: m.index, url: m.url }));
  for (const m of text.matchAll(IPV6_URL)) found.push({ at: m.index, url: m[0] });
  found.sort((a, b) => a.at - b.at);
  for (const m of found) {
    if (out.length >= max) break;
    if (!SAFE_URL.test(m.url) || seen.has(m.url)) continue;
    let u: URL;
    try {
      u = new URL(m.url);
    } catch {
      continue;
    }
    seen.add(m.url);
    const path = u.pathname === "/" ? "" : u.pathname;
    out.push({
      url: m.url,
      host: u.hostname.replace(/^www\./, ""),
      path: path.length > PATH_MAX ? `${path.slice(0, PATH_MAX)}…` : path,
    });
  }
  return out;
}
