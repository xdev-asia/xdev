import type { ReactNode } from "react";

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

// One pass, so "&amp;lt;" decodes to "&lt;" and not "<".
function decode(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]);
}

// Snippets are HTML-escaped except for <mark>; building nodes keeps any other markup inert text.
export function renderSnippet(s: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let inMark = false;
  for (const part of s.split(/(<mark>|<\/mark>)/)) {
    if (part === "<mark>") inMark = true;
    else if (part === "</mark>") inMark = false;
    else if (part !== "") nodes.push(inMark ? <mark key={nodes.length}>{decode(part)}</mark> : decode(part));
  }
  return nodes;
}
