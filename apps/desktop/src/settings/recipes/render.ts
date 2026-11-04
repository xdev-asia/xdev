const NAME = /^[A-Za-z0-9_]+$/;

/**
 * `template` with each `{name}` that `vars` has replaced by its value. An unknown `{name}` stays as
 * written; `{{` and `}}` are the braces themselves; a value is never expanded again. The same rules
 * as `recipes::render` in Rust, and the same fixture table.
 */
export function render(template: string, vars: Record<string, string>): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const c = template[i]!;
    if (c !== "{" && c !== "}") {
      out += c;
      i += 1;
    } else if (template[i + 1] === c) {
      out += c;
      i += 2;
    } else {
      const end = c === "{" ? template.indexOf("}", i + 1) : -1;
      const name = end < 0 ? "" : template.slice(i + 1, end);
      if (NAME.test(name) && Object.hasOwn(vars, name)) {
        out += vars[name];
        i = end + 1;
      } else {
        // A lone brace, or a name nobody gave: written as it is.
        out += c;
        i += 1;
      }
    }
  }
  return out;
}
