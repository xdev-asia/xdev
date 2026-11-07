const GUTTER_LEFT = /^ *\d* *[│┃║|] ?/;
const GUTTER_RIGHT = / ?[│┃║|] *$/;

/**
 * Text copied from a TUI without the box border or line-number gutter around it. Line ends stay as
 * they are; each line loses trailing blanks. A single line is never cut at a `|`.
 */
export function trimGutter(text: string): string {
  const parts = text.split(/(\r?\n)/);
  // parts alternate line, separator, line, ...
  const lines = parts.map((p, i) => (i % 2 === 0 ? p.replace(/[ \t]+$/, "") : p));
  const bodies = lines.filter((l, i) => i % 2 === 0 && l !== "");
  if (bodies.length >= 2) {
    const strip = (re: RegExp) => {
      const body = (i: number) => i % 2 === 0 && lines[i] !== "";
      if (!lines.every((l, i) => !body(i) || re.test(l))) return;
      for (let i = 0; i < lines.length; i += 2) if (body(i)) lines[i] = lines[i]!.replace(re, "");
    };
    strip(GUTTER_LEFT);
    strip(GUTTER_RIGHT);
  }
  return lines.join("");
}
