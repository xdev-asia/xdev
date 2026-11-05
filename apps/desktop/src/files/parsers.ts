import type { LanguageSupport } from "@codemirror/language";
import { fenceLanguage, type Parsers } from "@/doc/plugins/highlight";
import { loadLanguage, type Language } from "./languages";

const cache: Parsers = {};

/** The languages named by the code fences of `text`. */
export function fenceLanguages(text: string): Language[] {
  const found = new Set<Language>();
  for (const m of text.matchAll(/^[ \t]*(?:`{3,}|~{3,})[ \t]*([^\s`]*)/gm)) {
    const lang = fenceLanguage(m[1]);
    if (lang) found.add(lang);
  }
  return [...found];
}

/** Loads (once) the parsers for `langs`; a language that fails to load stays plain. */
export async function ensureParsers(langs: Language[]): Promise<Parsers> {
  await Promise.all(
    langs
      .filter((l) => !cache[l])
      .map((l) =>
        loadLanguage(l).then(
          (ext) => void (cache[l] = (ext as LanguageSupport).language?.parser),
          () => undefined,
        ),
      ),
  );
  return { ...cache };
}
