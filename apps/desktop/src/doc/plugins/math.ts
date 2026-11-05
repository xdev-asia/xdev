import katex from "katex";
import type MarkdownIt from "markdown-it";

const DOLLAR = 0x24;

function render(src: string, display: boolean, escape: (s: string) => string): string {
  try {
    return katex.renderToString(src, { displayMode: display, throwOnError: true, strict: "ignore", trust: false, output: "html" });
  } catch {
    // Bad TeX shows its source so the author can fix it.
    return `<${display ? "div" : "span"} class="md-math-error">${escape(src)}</${display ? "div" : "span"}>`;
  }
}

/** `$a+b$` inline and `$$ ... $$` as a block. A price like `$5 and $6` stays text. */
export function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.after("escape", "math_inline", (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== DOLLAR || state.src.charCodeAt(state.pos + 1) === DOLLAR) return false;
    const start = state.pos + 1;
    if (/\s/.test(state.src[start] ?? " ")) return false;
    let end = start;
    for (;;) {
      end = state.src.indexOf("$", end);
      if (end === -1 || end >= state.posMax) return false;
      if (state.src.charCodeAt(end - 1) !== 0x5c) break;
      end++;
    }
    const body = state.src.slice(start, end);
    if (/\s$/.test(body) || /\d/.test(state.src[end + 1] ?? "") || body.includes("\n")) return false;
    if (!silent) state.push("math_inline", "", 0).content = body;
    state.pos = end + 1;
    return true;
  });
  md.block.ruler.before("fence", "math_block", (state, startLine, endLine, silent) => {
    const first = state.bMarks[startLine] + state.tShift[startLine];
    const line = state.src.slice(first, state.eMarks[startLine]);
    if (!line.startsWith("$$") || state.sCount[startLine] - state.blkIndent >= 4) return false;
    const rest = line.slice(2);
    const lines: string[] = [];
    let next = startLine;
    if (rest.trimEnd().endsWith("$$") && rest.trim().length > 2) {
      lines.push(rest.trimEnd().slice(0, -2));
    } else {
      if (rest.trim() !== "") lines.push(rest);
      for (next = startLine + 1; next < endLine; next++) {
        const text = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
        if (text.trimEnd().endsWith("$$")) {
          const before = text.trimEnd().slice(0, -2);
          if (before.trim() !== "") lines.push(before);
          break;
        }
        lines.push(text);
      }
      if (next >= endLine) return false;
    }
    if (silent) return true;
    const token = state.push("math_block", "", 0);
    token.content = lines.join("\n");
    token.map = [startLine, next + 1];
    state.line = next + 1;
    return true;
  });
  md.renderer.rules.math_inline = (tokens, idx) => render(tokens[idx].content, false, md.utils.escapeHtml);
  md.renderer.rules.math_block = (tokens, idx) => `${render(tokens[idx].content, true, md.utils.escapeHtml)}\n`;
}
