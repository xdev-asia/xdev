import type { Api, ApiError, AppTheme, AppThemeInput, OnNameTaken } from "./api";
import fixtures from "./mockAppThemes.fixtures.json";
import { normalizeHex, slugOf } from "./mockThemes";

type AppThemesApi = Pick<Api, "appThemes" | "appThemeSave" | "appThemeRemove" | "appThemeImport" | "appThemeExport">;

export type MockAppThemes = AppThemesApi & {
  /** Every path `appThemeImport` knows, for a test's file dialog. */
  __appThemePaths(): string[];
  /** Paths `appThemeExport` wrote, with the text. */
  __appThemeExports(): { path: string; text: string }[];
};

/** The limits `app_themes.rs` checks. */
export const APP_THEME_LIMITS = { name: 60, slug: 33, keys: 40, key: 32, scheme: 40 } as const;

const fail = (code: ApiError["code"], detail?: string): ApiError => (detail === undefined ? { code } : { code, detail });

const colours = (raw: Record<string, string>, mode: string): Record<string, string> => {
  const entries = Object.entries(raw);
  if (entries.length > APP_THEME_LIMITS.keys) throw fail("theme_invalid", mode);
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[a-z0-9-]{1,32}$/.test(key)) throw fail("theme_invalid", key);
    out[key] = normalizeHex(value) ?? (() => { throw fail("theme_invalid", key); })();
  }
  return out;
};

/** `checked` in Rust. */
function checked(input: AppThemeInput): AppThemeInput {
  const name = input.name.trim();
  // eslint-disable-next-line no-control-regex
  if (name === "" || Array.from(name).length > APP_THEME_LIMITS.name || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw fail("theme_invalid", "name");
  if (input.terminalScheme !== undefined && !/^[a-z0-9-]{1,40}$/.test(input.terminalScheme)) throw fail("theme_invalid", "terminalScheme");
  const out: AppThemeInput = { name, dark: colours(input.dark, "dark"), light: colours(input.light, "light") };
  if (input.id !== undefined) out.id = input.id;
  if (input.terminalScheme !== undefined) out.terminalScheme = input.terminalScheme;
  return out;
}

/** `parse` in Rust. Throws the `ApiError` a bad file gives. */
export function parseAppThemeFile(text: string): AppThemeInput {
  if (text.length > 64 * 1024) throw fail("theme_too_large");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw fail("theme_invalid", "file");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw fail("theme_invalid", "file");
  const o = doc as Record<string, unknown>;
  if (o.format !== "xdev-app-theme") throw fail("theme_invalid", "format");
  if (o.version !== 1) throw fail("theme_invalid", "version");
  const mode = (key: "dark" | "light"): Record<string, string> => {
    const v = o[key];
    if (v === undefined) return {};
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw fail("theme_invalid", key);
    return v as Record<string, string>;
  };
  const input: AppThemeInput = { name: typeof o.name === "string" ? o.name : "", dark: mode("dark"), light: mode("light") };
  if (typeof o.terminalScheme === "string") input.terminalScheme = o.terminalScheme;
  return checked(input);
}

const numberedName = (name: string, n: number): string => {
  const suffix = ` ${n}`;
  return `${Array.from(name).slice(0, APP_THEME_LIMITS.name - suffix.length).join("").trimEnd()}${suffix}`;
};

/**
 * The app themes in memory. A path is a key into `files` (a theme file's JSON or its text;
 * `mockAppThemes.fixtures.json` when left out), so no test touches a disk. Like Rust, a change
 * emits nothing: the page reads the list again.
 */
export function createMockAppThemes(files: Record<string, unknown> = fixtures): MockAppThemes {
  const stored = new Map<string, AppTheme>();
  const exported: { path: string; text: string }[] = [];
  const idOf = (name: string) => slugOf(name, APP_THEME_LIMITS.slug);
  const put = (id: string, input: AppThemeInput): AppTheme => {
    const theme: AppTheme = { id, name: input.name, dark: input.dark, light: input.light };
    if (input.terminalScheme !== undefined) theme.terminalScheme = input.terminalScheme;
    stored.set(id, theme);
    return structuredClone(theme);
  };
  return {
    __appThemePaths: () => Object.keys(files),
    __appThemeExports: () => structuredClone(exported),
    async appThemes() {
      return [...stored.values()]
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
        .map((t) => structuredClone(t));
    },
    async appThemeSave(input) {
      const c = checked(input);
      const id = idOf(c.name);
      if (c.id === undefined) {
        if (stored.has(id)) throw fail("name_taken", stored.get(id)!.name);
      } else {
        if (!stored.has(c.id)) throw fail("not_found");
        if (c.id !== id && stored.has(id)) throw fail("name_taken", stored.get(id)!.name);
      }
      const old = c.id;
      const saved = put(id, c);
      if (old !== undefined && old !== id) stored.delete(old);
      return saved;
    },
    async appThemeRemove(id) {
      if (!stored.delete(id)) throw fail("not_found");
      },
    async appThemeImport(path, onTaken: OnNameTaken) {
      if (!(path in files)) throw fail("not_found");
      const raw = files[path];
      const input = parseAppThemeFile(typeof raw === "string" ? raw : JSON.stringify(raw));
      let id = idOf(input.name);
      if (stored.has(id)) {
        if (onTaken === "fail") throw fail("name_taken", stored.get(id)!.name);
        if (onTaken === "keepBoth") {
          for (let n = 2; ; n++) {
            const name = numberedName(input.name, n);
            if (!stored.has(idOf(name))) {
              input.name = name;
              id = idOf(name);
              break;
            }
          }
        }
      }
      return put(id, input);
    },
    async appThemeExport(id) {
      const t = stored.get(id);
      if (!t) throw fail("not_found");
      const doc: Record<string, unknown> = { format: "xdev-app-theme", version: 1, name: t.name, dark: t.dark, light: t.light };
      if (t.terminalScheme !== undefined) doc.terminalScheme = t.terminalScheme;
      const path = `/home/demo/${t.id}.xdev-theme.json`;
      exported.push({ path, text: JSON.stringify(doc, null, 2) });
      return path;
    },
  };
}
