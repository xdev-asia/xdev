import { javascript } from "@codemirror/lang-javascript";
import { highlightTree } from "@lezer/highlight";
import { expect, it } from "vitest";
import { highlight } from "./Editor";

// The shared highlighter must colour code, not only markdown: a source file with no classes on its
// tokens renders as plain text.
it("gives keywords, strings, comments, numbers and calls their own classes", () => {
  const code = 'const answer = add(1, "two"); // done';
  const tree = javascript().language.parser.parse(code);
  const classes = new Map<string, string>();
  highlightTree(tree, highlight, (from, to, cls) => classes.set(code.slice(from, to), cls));
  for (const text of ["const", '"two"', "// done", "1", "add"]) expect(classes.get(text), text).toBeTruthy();
  expect(new Set([classes.get("const"), classes.get('"two"'), classes.get("// done"), classes.get("1"), classes.get("add")]).size).toBe(5);
});

it("uses palette tokens only", () => {
  const css = highlight.module?.getRules() ?? "";
  expect(css).toContain("var(--violet)");
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
});
