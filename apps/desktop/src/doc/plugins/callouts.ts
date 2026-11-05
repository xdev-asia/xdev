import type MarkdownIt from "markdown-it";

export const CALLOUTS = ["note", "tip", "important", "warning", "caution"] as const;
export type Callout = (typeof CALLOUTS)[number];
export const CALLOUT_TITLES: Record<Callout, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i;

/** `> [!NOTE]` and friends become a titled callout box. `env.callouts` overrides the titles. */
export function calloutsPlugin(md: MarkdownIt): void {
  md.core.ruler.after("block", "callouts", (state) => {
    const titles = { ...CALLOUT_TITLES, ...((state.env as { callouts?: Partial<Record<Callout, string>> }).callouts ?? {}) };
    const tokens = state.tokens;
    for (let i = 0; i + 2 < tokens.length; i++) {
      if (tokens[i].type !== "blockquote_open" || tokens[i + 1].type !== "paragraph_open" || tokens[i + 2].type !== "inline") continue;
      const inline = tokens[i + 2];
      const match = MARKER.exec(inline.content);
      if (!match) continue;
      const kind = match[1].toLowerCase() as Callout;
      inline.content = inline.content.slice(match[0].length).replace(/^\n/, "");
      tokens[i].attrJoin("class", `md-callout md-callout-${kind}`);
      const open = new state.Token("paragraph_open", "p", 1);
      open.attrJoin("class", "md-callout-title");
      const title = new state.Token("inline", "", 0);
      title.content = titles[kind];
      title.children = [];
      const close = new state.Token("paragraph_close", "p", -1);
      tokens.splice(i + 1, 0, open, title, close);
      // Drop the body paragraph when the marker was all it held.
      if (inline.content === "") tokens.splice(i + 4, 3);
    }
  });
}
