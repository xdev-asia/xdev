/**
 * `template` with each `{name}` that `vars` has replaced by its value. An unknown `{name}` stays as
 * written; `{{` and `}}` are the braces themselves; a value is never expanded again. The same rules
 * as `recipes::render` in Rust.
 */
export function render(template: string, vars: Record<string, string>): string {
  // The renderer arrives with the tests of U1.
  void vars;
  return template;
}
