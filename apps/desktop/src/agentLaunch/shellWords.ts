/** The words of `text` as a POSIX shell would split them, with no expansion: quotes and backslashes only. */
export type ShellWords = { words: string[]; error: "unterminated" | null };

export function splitShellWords(text: string): ShellWords {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1]!)) word += text[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\") {
      if (i + 1 < text.length) {
        word += text[++i];
        inWord = true;
      } else {
        return { words, error: "unterminated" };
      }
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) return { words, error: "unterminated" };
  if (inWord) words.push(word);
  return { words, error: null };
}
