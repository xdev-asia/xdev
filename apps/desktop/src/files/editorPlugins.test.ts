import { EditorView } from "codemirror";
import { expect, it } from "vitest";
import { editorPluginsVersion, registerEditorPlugin } from "./editorPlugins";

it("register and unregister bump the version", () => {
  const v0 = editorPluginsVersion();
  const off = registerEditorPlugin("t1", () => []);
  expect(editorPluginsVersion()).toBe(v0 + 1);
  off();
  expect(editorPluginsVersion()).toBe(v0 + 2);
});

it("the same id replaces, and the old unregister leaves the new one", () => {
  const first = registerEditorPlugin("t2", () => EditorView.editorAttributes.of({ class: "one" }));
  const second = registerEditorPlugin("t2", () => EditorView.editorAttributes.of({ class: "two" }));
  const v = editorPluginsVersion();
  first();
  expect(editorPluginsVersion()).toBe(v);
  second();
  expect(editorPluginsVersion()).toBe(v + 1);
});
