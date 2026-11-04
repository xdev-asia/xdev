import type { Api, ApiError, CustomScheme, OnNameTaken, SchemeColors, SchemePreview } from "./api";
import fixtures from "./mockThemes.fixtures.json";
import type { SettingsEmit } from "./mockSettings";

type ThemesApi = Pick<Api, "terminalThemes" | "terminalThemePreview" | "terminalThemeImport" | "terminalThemeRemove">;

export type MockThemes = ThemesApi & {
  /** Every path `terminalThemePreview` knows, for a test's file dialog. */
  __paths(): string[];
};

/** The limits `terminal_themes.rs` checks. */
export const THEME_LIMITS = { name: 60, slug: 33, minContrast: 3 } as const;

const REQUIRED = [
  "foreground", "background", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
const OPTIONAL = ["cursor", "cursorAccent", "selectionBackground"] as const;
const KNOWN = new Set<string>(["format", "version", "name", "kind", ...REQUIRED, ...OPTIONAL]);

function fail(code: ApiError["code"], detail?: string): ApiError {
  return detail === undefined ? { code } : { code, detail };
}

/** `normalize_hex` in Rust: `#rgb` or `#rrggbb` as lower-case `#rrggbb`. */
export function normalizeHex(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw);
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  return "#" + (h.length === 3 ? [...h].map((c) => c + c).join("") : h);
}

function luminance(hex: string): number {
  const lin = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
}

/** `contrast_ratio` in Rust (WCAG). */
export function contrastRatio(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** `slug` in Rust. */
export function slugOf(name: string, max: number = THEME_LIMITS.slug): string {
  const out = name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+/, "").toLowerCase();
  const cut = out.slice(0, max).replace(/-+$/, "");
  return cut === "" ? "theme" : cut;
}

function mixQuarter(a: string, b: string): string {
  const ch = (i: number) => Math.round(parseInt(a.slice(i, i + 2), 16) * 0.75 + parseInt(b.slice(i, i + 2), 16) * 0.25);
  return "#" + [1, 3, 5].map((i) => ch(i).toString(16).padStart(2, "0")).join("");
}

type Parsed = { scheme: CustomScheme; ignoredKeys: string[] };

/** `parse` in Rust. Throws the `ApiError` a bad file gives. */
export function parseThemeFile(text: string): Parsed {
  const bad = (field: string): never => {
    throw fail("theme_invalid", field);
  };
  if (text.length > 64 * 1024) throw fail("theme_too_large");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return bad("file");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return bad("file");
  const obj = doc as Record<string, unknown>;
  if (obj.format !== "xdev-terminal-theme") bad("format");
  if (obj.version !== 1) bad("version");
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  // eslint-disable-next-line no-control-regex
  if (name === "" || Array.from(name).length > THEME_LIMITS.name || /[\u0000-\u001f\u007f-\u009f]/.test(name)) bad("name");
  const colour = (key: string): string | null => {
    if (!(key in obj)) return null;
    return normalizeHex(obj[key]) ?? bad(key);
  };
  for (const key of REQUIRED) if (colour(key) === null) bad(key);
  const c = Object.fromEntries(REQUIRED.map((k) => [k, colour(k)!])) as Record<(typeof REQUIRED)[number], string>;
  const cursor = colour("cursor") ?? c.foreground;
  const cursorAccent = colour("cursorAccent") ?? c.background;
  const selectionBackground = colour("selectionBackground") ?? mixQuarter(c.background, c.foreground);
  let mode: "dark" | "light";
  if (!("kind" in obj)) mode = luminance(c.background) > 0.179 ? "light" : "dark";
  else if (obj.kind === "dark" || obj.kind === "light") mode = obj.kind;
  else return bad("kind");
  const colors: SchemeColors = { ...c, cursor, cursorAccent, selectionBackground };
  return {
    scheme: { id: `custom-${slugOf(name)}`, name, mode, colors },
    ignoredKeys: Object.keys(obj).filter((k) => !KNOWN.has(k)).sort(),
  };
}

function numbered(base: string, n: number): string {
  const suffix = `-${n}`;
  return base.slice(0, THEME_LIMITS.slug - suffix.length).replace(/-+$/, "") + suffix;
}

/**
 * The imported schemes in memory. A path is a key into `files` (path to a theme file's JSON, or its
 * text; `mockThemes.fixtures.json` when left out), so no test touches a disk. Import and remove call
 * `emit`, the way Rust emits `settings://changed` for the terminal section.
 */
export function createMockThemes(files: Record<string, unknown> = fixtures, emit: SettingsEmit = () => {}): MockThemes {
  const stored = new Map<string, CustomScheme>();
  const parsed = (path: string): Parsed => {
    if (!(path in files)) throw fail("io", "not found");
    const raw = files[path];
    return parseThemeFile(typeof raw === "string" ? raw : JSON.stringify(raw));
  };
  return {
    __paths: () => Object.keys(files),
    async terminalThemes() {
      return [...stored.values()]
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
        .map((s) => structuredClone(s));
    },
    async terminalThemePreview(path): Promise<SchemePreview> {
      const { scheme, ignoredKeys } = parsed(path);
      return {
        scheme,
        ignoredKeys,
        lowContrast: contrastRatio(scheme.colors.foreground, scheme.colors.background) < THEME_LIMITS.minContrast,
        nameTaken: stored.has(scheme.id),
      };
    },
    async terminalThemeImport(path, onTaken: OnNameTaken) {
      const { scheme } = parsed(path);
      let id = scheme.id;
      if (stored.has(id)) {
        if (onTaken === "fail") throw fail("theme_name_taken");
        if (onTaken === "keepBoth") {
          const base = id.slice("custom-".length);
          for (let n = 2; ; n++) {
            id = `custom-${numbered(base, n)}`;
            if (!stored.has(id)) break;
          }
        }
      }
      const out = { ...scheme, id };
      stored.set(id, out);
      emit(["terminal"]);
      return structuredClone(out);
    },
    async terminalThemeRemove(id) {
      if (!stored.delete(id)) throw fail("not_found");
      emit(["terminal"]);
    },
  };
}
