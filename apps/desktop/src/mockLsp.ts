import type {
  Api,
  ApiError,
  ErrorCode,
  LspCompletionItem,
  LspDiagnostic,
  LspEvent,
  LspFileEdit,
  LspLanguage,
  LspLocation,
  LspPos,
  LspRange,
  LspRunning,
  LspServerInfo,
  LspSettings,
  LspSymbol,
} from "./api";

type LspApi = Pick<
  Api,
  | "lspServers"
  | "lspSettingsGet"
  | "lspSettingsPut"
  | "lspSubscribe"
  | "lspTrust"
  | "lspOpen"
  | "lspChange"
  | "lspClose"
  | "lspHover"
  | "lspDefinition"
  | "lspCompletion"
  | "lspPrepareRename"
  | "lspRename"
  | "lspWorkspaceSymbols"
  | "lspRestart"
  | "lspStatus"
>;

const LANGUAGES: LspLanguage[] = ["typescript", "rust", "python", "go", "csharp"];
const PROGRAMS: Record<LspLanguage, string> = {
  typescript: "typescript-language-server",
  rust: "rust-analyzer",
  python: "pyright-langserver",
  go: "gopls",
  csharp: "csharp-ls",
};
// The servers this demo machine has; the rest are not installed.
const FOUND: Partial<Record<LspLanguage, string>> = {
  typescript: "/usr/local/bin/typescript-language-server",
  rust: "/usr/local/bin/rust-analyzer",
};
const IDS: Record<string, LspLanguage> = {
  typescript: "typescript",
  typescriptreact: "typescript",
  javascript: "typescript",
  javascriptreact: "typescript",
  rust: "rust",
  python: "python",
  go: "go",
  csharp: "csharp",
};
const DECLARATION = /^\s*export\s+(?:default\s+)?(?:async\s+)?(function|const|class|interface|type)\s+([A-Za-z_$][\w$]*)/;
// LSP SymbolKind and CompletionItemKind of each declaration.
const SYMBOL_KIND: Record<string, number> = { function: 12, const: 14, class: 5, interface: 11, type: 26 };
const COMPLETION_KIND: Record<string, number> = { function: 3, const: 21, class: 7, interface: 8, type: 25 };

type Doc = { worktree: string; rel: string; language: LspLanguage; text: string };
type Declared = { name: string; kind: string; rel: string; line: string; range: LspRange };

function fail(code: ErrorCode, detail?: string): never {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  throw error;
}

function key(worktree: string, rel: string): string {
  return `${worktree}\n${rel}`;
}

function isWord(c: string | undefined): boolean {
  return c !== undefined && /[\w$]/.test(c);
}

/** The identifier under `pos`, with its range. */
export function wordAt(text: string, pos: LspPos): { word: string; range: LspRange } | null {
  const line = text.split("\n")[pos.line];
  if (line === undefined) return null;
  let start = Math.min(pos.character, line.length);
  let end = start;
  while (start > 0 && isWord(line[start - 1])) start--;
  while (end < line.length && isWord(line[end])) end++;
  if (start === end) return null;
  return { word: line.slice(start, end), range: { start: { line: pos.line, character: start }, end: { line: pos.line, character: end } } };
}

function wholeWords(text: string, word: string): LspRange[] {
  const escaped = word.replace(/[$]/g, "\\$");
  const pattern = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, "g");
  return text.split("\n").flatMap((line, n) =>
    [...line.matchAll(pattern)].map((m) => ({
      start: { line: n, character: m.index },
      end: { line: n, character: m.index + word.length },
    })),
  );
}

function todos(text: string): LspDiagnostic[] {
  return text.split("\n").flatMap((line, n) => {
    const at = line.indexOf("TODO");
    if (at < 0) return [];
    const range = { start: { line: n, character: at }, end: { line: n, character: at + 4 } };
    return [{ range, severity: 2, message: "Unfinished work: TODO", source: "demo", code: null }];
  });
}

/** Language servers in memory: TypeScript and Rust are installed, a worktree needs `lspTrust` first, and the index is the `export` declarations of the open .ts and .tsx files. */
export function createMockLsp(): LspApi {
  let settings: LspSettings = { enabled: true, disabled: [], idleMinutes: 10, trusted: [] };
  const untrustedSession = new Set<string>();
  const docs = new Map<string, Doc>();
  // Running servers, `worktree\nlanguage`.
  const running = new Set<string>();
  let sink: ((e: LspEvent) => void) | null = null;

  const emit = (e: LspEvent) => sink?.(e);
  const status = (worktree: string, language: LspLanguage, state: "ready" | "stopped") =>
    emit({ kind: "status", worktree, language, state });
  const docOf = (worktree: string, rel: string): Doc => docs.get(key(worktree, rel)) ?? fail("not_found");
  const docsOf = (worktree: string) => [...docs.values()].filter((d) => d.worktree === worktree);

  const index = (worktree: string): Declared[] =>
    docsOf(worktree)
      .filter((d) => /\.tsx?$/.test(d.rel))
      .flatMap((d) =>
        d.text.split("\n").flatMap((line, n) => {
          const m = DECLARATION.exec(line);
          if (!m) return [];
          const [, kind, name] = m;
          const at = line.indexOf(name, m[0].length - name.length);
          const range = { start: { line: n, character: at }, end: { line: n, character: at + name.length } };
          return [{ name, kind, rel: d.rel, line: line.trim(), range }];
        }),
      );
  const declared = (worktree: string, rel: string, pos: LspPos) => {
    const hit = wordAt(docOf(worktree, rel).text, pos);
    if (!hit) return null;
    const decl = index(worktree).find((d) => d.name === hit.word);
    return decl ? { decl, range: hit.range } : null;
  };
  const stop = (pred: (language: LspLanguage) => boolean) => {
    for (const entry of [...running]) {
      const [worktree, language] = entry.split("\n") as [string, LspLanguage];
      if (!pred(language)) continue;
      running.delete(entry);
      for (const [k, d] of docs) if (d.worktree === worktree && d.language === language) docs.delete(k);
      status(worktree, language, "stopped");
    }
  };

  return {
    async lspServers() {
      return LANGUAGES.map(
        (language): LspServerInfo => ({
          language,
          program: PROGRAMS[language],
          path: FOUND[language] ?? null,
          enabled: settings.enabled && !settings.disabled.includes(language),
          running: [...running].filter((r) => r.endsWith(`\n${language}`)).length,
        }),
      );
    },
    async lspSettingsGet() {
      return structuredClone(settings);
    },
    async lspSettingsPut(next) {
      settings = {
        enabled: next.enabled,
        disabled: LANGUAGES.filter((l) => next.disabled.includes(l)),
        idleMinutes: Math.min(120, Math.max(1, Math.round(next.idleMinutes))),
        trusted: [...new Set(next.trusted.filter((t) => t !== ""))],
      };
      stop((l) => !settings.enabled || settings.disabled.includes(l));
      return structuredClone(settings);
    },
    async lspSubscribe(cb) {
      sink = cb;
      return () => {
        if (sink === cb) sink = null;
      };
    },
    async lspTrust(worktree, trusted) {
      const others = settings.trusted.filter((t) => t !== worktree);
      settings = { ...settings, trusted: trusted ? [...others, worktree] : others };
      if (trusted) untrustedSession.delete(worktree);
      else untrustedSession.add(worktree);
    },
    async lspOpen(worktree, rel, languageId, _version, text) {
      if (!settings.enabled) fail("lsp_off");
      const language = IDS[languageId] ?? null;
      if (!language) return { language: null, state: "notFound" };
      if (settings.disabled.includes(language)) fail("lsp_off", language);
      if (untrustedSession.has(worktree)) fail("lsp_untrusted", "session");
      if (!settings.trusted.includes(worktree)) fail("lsp_untrusted");
      if (!FOUND[language]) fail("lsp_not_found", language);
      docs.set(key(worktree, rel), { worktree, rel, language, text });
      const server = `${worktree}\n${language}`;
      if (!running.has(server)) {
        running.add(server);
        status(worktree, language, "ready");
      }
      emit({ kind: "diagnostics", worktree, rel, items: todos(text) });
      return { language, state: "ready" };
    },
    async lspChange(worktree, rel, _version, text) {
      docOf(worktree, rel).text = text;
      emit({ kind: "diagnostics", worktree, rel, items: todos(text) });
    },
    async lspClose(worktree, rel) {
      docs.delete(key(worktree, rel));
    },
    async lspHover(worktree, rel, pos) {
      const hit = declared(worktree, rel, pos);
      return hit ? { markdown: "```ts\n" + hit.decl.line + "\n```", range: hit.range } : null;
    },
    async lspDefinition(worktree, rel, pos) {
      const hit = declared(worktree, rel, pos);
      if (!hit) return [];
      const at: LspLocation = { rel: hit.decl.rel, path: `${worktree}/${hit.decl.rel}`, range: hit.decl.range };
      return [at];
    },
    async lspCompletion(worktree, rel) {
      docOf(worktree, rel);
      const items = index(worktree).map(
        (d): LspCompletionItem => ({
          label: d.name,
          kind: COMPLETION_KIND[d.kind] ?? null,
          detail: d.rel,
          insertText: d.name,
          range: null,
          sortText: null,
          filterText: null,
        }),
      );
      return { incomplete: false, items };
    },
    async lspPrepareRename(worktree, rel, pos) {
      return wordAt(docOf(worktree, rel).text, pos)?.range ?? null;
    },
    async lspRename(worktree, rel, pos, newName) {
      const hit = wordAt(docOf(worktree, rel).text, pos) ?? fail("lsp_unsupported", "Nothing to rename here");
      const files = docsOf(worktree)
        .map((d): LspFileEdit => ({ rel: d.rel, edits: wholeWords(d.text, hit.word).map((range) => ({ range, newText: newName })) }))
        .filter((f) => f.edits.length > 0);
      return { files, skipped: 0 };
    },
    async lspWorkspaceSymbols(worktree, query) {
      if (![...running].some((r) => r.startsWith(`${worktree}\n`))) fail("lsp_not_found");
      const q = query.toLowerCase();
      return index(worktree)
        .filter((d) => d.name.toLowerCase().includes(q))
        .map((d): LspSymbol => ({ name: d.name, kind: SYMBOL_KIND[d.kind] ?? 13, container: null, rel: d.rel, range: d.range }));
    },
    async lspRestart(worktree) {
      for (const entry of running) {
        const [w, language] = entry.split("\n") as [string, LspLanguage];
        if (worktree === null || w === worktree) status(w, language, "ready");
      }
    },
    async lspStatus() {
      return [...running].sort().map((entry): LspRunning => {
        const [worktree, language] = entry.split("\n") as [string, LspLanguage];
        const openDocs = [...docs.values()].filter((d) => d.worktree === worktree && d.language === language).length;
        return { worktree, language, state: "ready", openDocs };
      });
    },
  };
}
