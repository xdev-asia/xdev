import type { StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

type Loader = () => Promise<Extension>;

// One lazy import per language, so a package is fetched only when a file of its kind opens.
const javascript = (opts: { jsx?: boolean; typescript?: boolean }): Loader => () =>
  import("@codemirror/lang-javascript").then((m) => m.javascript(opts));
// A CodeMirror 5 style mode, wrapped in a stream language.
const legacy = (parser: () => Promise<StreamParser<unknown>>): Loader => async () => {
  const [{ StreamLanguage }, p] = await Promise.all([import("@codemirror/language"), parser()]);
  return StreamLanguage.define(p);
};
/**
 * C# names its types in PascalCase, but the clike mode only knows the built-in ones, so `List`,
 * `HttpClient` or a project's own classes read as plain names. A capitalised name that is not a
 * member (`x.Name`), a method call (`Run(`) or an ALL_CAPS constant is styled as a type.
 */
export function pascalTypes<S>(parser: StreamParser<S>): StreamParser<S> {
  return {
    ...parser,
    token(stream, state) {
      const style = parser.token(stream, state);
      if (style !== "variable") return style;
      const word = stream.current();
      if (!/^[A-Z]/.test(word) || /^[A-Z0-9_]{2,}$/.test(word)) return style;
      const before = stream.string.slice(0, stream.start);
      if (/\.\s*$/.test(before)) return style;
      if (/^\s*\(/.test(stream.string.slice(stream.pos)) && !/\bnew\s+$/.test(before)) return style;
      return "type";
    },
  };
}

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
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  java: () => import("@codemirror/lang-java").then((m) => m.java()),
  cpp: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  php: () => import("@codemirror/lang-php").then((m) => m.php()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  csharp: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => pascalTypes(m.csharp))),
  kotlin: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin)),
  shell: legacy(() => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell)),
  toml: legacy(() => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml)),
  // No ini mode exists; the properties mode reads keys, values and comments alike.
  ini: legacy(() => import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties)),
  properties: legacy(() => import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties)),
  dockerfile: legacy(() => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile)),
  lua: legacy(() => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua)),
  ruby: legacy(() => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby)),
  swift: legacy(() => import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift)),
  diff: legacy(() => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff)),
  groovy: legacy(() => import("@codemirror/legacy-modes/mode/groovy").then((m) => m.groovy)),
  perl: legacy(() => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl)),
  r: legacy(() => import("@codemirror/legacy-modes/mode/r").then((m) => m.r)),
  powershell: legacy(() => import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell)),
  protobuf: legacy(() => import("@codemirror/legacy-modes/mode/protobuf").then((m) => m.protobuf)),
  scala: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.scala)),
  dart: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.dart)),
  cmake: legacy(() => import("@codemirror/legacy-modes/mode/cmake").then((m) => m.cmake)),
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
  go: "go",
  java: "java",
  c: "cpp", h: "cpp", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  xml: "xml", svg: "xml", xsd: "xml", plist: "xml",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  toml: "toml",
  ini: "ini", cfg: "ini", conf: "ini",
  dockerfile: "dockerfile",
  lua: "lua",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin", kts: "kotlin",
  diff: "diff", patch: "diff",
  properties: "properties",
  pl: "perl", pm: "perl",
  r: "r",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  proto: "protobuf",
  scala: "scala", sbt: "scala",
  dart: "dart",
  // No vue or svelte package: their templates read as html.
  vue: "html", svelte: "html",
  dockerignore: "ini",
};

// Checked before the extension, by lowercase name. There is no makefile mode in the legacy modes,
// so Makefile and Justfile read as shell.
const BY_FILENAME: Record<string, Language> = {
  dockerfile: "dockerfile",
  jenkinsfile: "groovy",
  makefile: "shell",
  gnumakefile: "shell",
  justfile: "shell",
  ".justfile": "shell",
  "cmakelists.txt": "cmake",
  "cargo.lock": "toml",
  ".gitignore": "ini",
  ".dockerignore": "ini",
  ".gitattributes": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".env": "properties",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
  ".bash_profile": "shell",
  ".envrc": "shell",
};

const SHEBANG = /^#!\s*\S*?\/(?:env\s+(?:-\S+\s+)*)?(bash|sh|zsh|python[\d.]*|node)\b/;

function shebangLanguage(firstLine: string): Language | null {
  const kind = SHEBANG.exec(firstLine)?.[1];
  if (!kind) return null;
  if (kind === "node") return "js";
  return kind.startsWith("python") ? "python" : "shell";
}

/**
 * The language of a file: by its name, then its extension; for a name with no extension, by the
 * `#!` line when `firstLine` is given. Null for plain text.
 */
export function languageOf(rel: string, firstLine?: string): Language | null {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  const named = BY_FILENAME[lower] ?? (lower.startsWith(".env.") ? "properties" : lower.startsWith("dockerfile.") ? "dockerfile" : undefined);
  if (named) return named;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return firstLine === undefined ? null : shebangLanguage(firstLine);
  return BY_EXTENSION[lower.slice(dot + 1)] ?? null;
}

/** Loads the CodeMirror extension for `lang`. */
export function loadLanguage(lang: Language): Promise<Extension> {
  return LOADERS[lang]();
}
