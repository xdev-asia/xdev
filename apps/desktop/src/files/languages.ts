import type { Extension } from "@codemirror/state";

type Loader = () => Promise<Extension>;

// One lazy import per language, so a package is fetched only when a file of its kind opens.
const javascript = (opts: { jsx?: boolean; typescript?: boolean }): Loader => () =>
  import("@codemirror/lang-javascript").then((m) => m.javascript(opts));
const LOADERS = {
  js: javascript({ jsx: true }),
  ts: javascript({ typescript: true, jsx: true }),
  rust: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  python: () => import("@codemirror/lang-python").then((m) => m.python()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
} satisfies Record<string, Loader>;

export type Language = keyof typeof LOADERS;

const BY_EXTENSION: Record<string, Language> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  rs: "rust",
  json: "json", jsonc: "json",
  css: "css",
  html: "html", htm: "html",
  py: "python",
  yml: "yaml", yaml: "yaml",
  md: "markdown", markdown: "markdown",
};

/** The language of a file by its extension; null for plain text. */
export function languageOf(rel: string): Language | null {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Loads the CodeMirror extension for `lang`. */
export function loadLanguage(lang: Language): Promise<Extension> {
  return LOADERS[lang]();
}
