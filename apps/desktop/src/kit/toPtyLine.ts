/**
 * One line that is safe to type into a terminal. Every run of whitespace, including each kind
 * of line break, becomes one space, so nothing in it presses Enter; the other control
 * characters (escape, NUL, delete) are dropped so no sequence reaches the terminal.
 */
export function toPtyLine(text: string): string {
  return text
    .replace(/[\s\u0085]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
}
