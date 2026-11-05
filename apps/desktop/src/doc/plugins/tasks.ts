import type MarkdownIt from "markdown-it";

const MARK = /^\[([ xX])\][ \t]+/;

/** `- [ ]` and `- [x]` items get a disabled checkbox. */
export function tasksPlugin(md: MarkdownIt): void {
  md.core.ruler.after("inline", "task_lists", (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
      const first = inline.children?.[0];
      const match = first?.type === "text" ? MARK.exec(first.content) : null;
      if (!first || !match) continue;
      first.content = first.content.slice(match[0].length);
      const box = new state.Token("html_inline", "", 0);
      box.content = `<input class="md-task" type="checkbox" disabled${match[1] === " " ? "" : " checked"}> `;
      inline.children!.unshift(box);
      tokens[i - 2].attrJoin("class", "md-task-item");
    }
  });
}
