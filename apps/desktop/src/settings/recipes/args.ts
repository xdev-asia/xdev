/** Splits on spaces; single or double quotes keep spaces in one arg, and a backslash escapes the next character. */
export function splitArgs(text: string): string[] {
  const args: string[] = [];
  let cur = "";
  let quote: string | null = null;
  // An empty pair of quotes is still an arg.
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && quote !== "'" && i + 1 < text.length) {
      cur += text[++i];
      started = true;
    } else if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) args.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) args.push(cur);
  return args;
}

/** The text that `splitArgs` reads back as `args`. */
export function joinArgs(args: readonly string[]): string {
  return args
    .map((a) => {
      if (a !== "" && !/[\s"'\\]/.test(a)) return a;
      return `"${a.replace(/(["\\])/g, "\\$1")}"`;
    })
    .join(" ");
}
