// Stand-in for @xdev-asia/ui theme overrides; delete when the pin has them.
//
// Same names and signatures as the library brief (theme-editor-ui §1). The theme keys, the token
// variables each key sets and the contrast pairs come from the theme editor plan. No colour literal
// lives here: a value is only ever a validated `#rrggbb` string, and the derived tints are
// `color-mix()` of that value.

export type ThemeGroup = "surface" | "text" | "line" | "accent" | "status";

export const THEME_GROUPS: readonly ThemeGroup[] = ["surface", "text", "line", "accent", "status"];

export interface ThemeKeySpec {
  key: string;
  group: ThemeGroup;
  vars: readonly string[];
  derived?: readonly { var: string; percent: number }[];
}

const mix = (name: string, percent: number) => ({ var: name, percent });

export const THEME_KEYS: readonly ThemeKeySpec[] = [
  { key: "surface-0", group: "surface", vars: ["--bg-0", "--x-color-bg"] },
  { key: "surface-1", group: "surface", vars: ["--bg-1", "--x-color-panel"] },
  { key: "surface-2", group: "surface", vars: ["--bg-2", "--x-color-surface"] },
  { key: "surface-3", group: "surface", vars: ["--bg-3", "--x-color-surface-2"] },
  { key: "term", group: "surface", vars: ["--term"] },
  { key: "side-tint", group: "surface", vars: ["--side-tint"] },
  { key: "text-1", group: "text", vars: ["--text-1", "--x-color-ink"] },
  { key: "text-2", group: "text", vars: ["--text-2", "--x-color-muted"] },
  { key: "text-3", group: "text", vars: ["--text-3"] },
  { key: "line", group: "line", vars: ["--line", "--x-color-line"] },
  { key: "accent", group: "accent", vars: ["--accent", "--x-color-accent"], derived: [mix("--x-color-accent-soft", 18)] },
  { key: "signal", group: "accent", vars: ["--signal", "--x-color-signal"], derived: [mix("--signal-bg", 12), mix("--x-color-signal-soft", 12)] },
  { key: "ok", group: "status", vars: ["--ok", "--x-color-ok"], derived: [mix("--ok-bg", 12), mix("--x-color-ok-soft", 12)] },
  { key: "warn", group: "status", vars: ["--warn", "--x-color-warn"], derived: [mix("--warn-bg", 12), mix("--x-color-warn-soft", 12), mix("--x-color-warn-line", 35)] },
  { key: "danger", group: "status", vars: ["--danger", "--x-color-danger"], derived: [mix("--danger-bg", 12), mix("--x-color-danger-soft", 12)] },
  { key: "violet", group: "status", vars: ["--violet"], derived: [mix("--violet-bg", 12)] },
  { key: "orange", group: "status", vars: ["--orange"], derived: [mix("--orange-bg", 12)] },
];

export type ThemeKey = (typeof THEME_KEYS)[number]["key"];
/** key → `#rrggbb`. */
export type ThemeColors = Partial<Record<string, string>>;
export interface ThemeOverrides {
  dark?: ThemeColors;
  light?: ThemeColors;
}

/** Three or six hex digits after a hash, as lower-case six digits; anything else (a name, a stray brace, `url(x)`) is null. */
export function normalizeHex(raw: string): string | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw);
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  return "#" + (h.length === 3 ? [...h].map((c) => c + c).join("") : h);
}

/** custom property → value, for every known key with a valid value; the rest is dropped. */
export function overrideVars(colors: ThemeColors): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of THEME_KEYS) {
    const raw = colors[spec.key];
    const hex = typeof raw === "string" ? normalizeHex(raw) : null;
    if (!hex) continue;
    for (const v of spec.vars) out[v] = hex;
    for (const d of spec.derived ?? []) out[d.var] = `color-mix(in srgb, ${hex} ${d.percent}%, transparent)`;
  }
  return out;
}

const rule = (mode: "dark" | "light", colors: ThemeColors | undefined): string => {
  const decls = Object.entries(overrideVars(colors ?? {}));
  if (decls.length === 0) return "";
  const body = decls.map(([k, v]) => `${k}: ${v};`).join(" ");
  return `html[data-theme="${mode}"], html [data-theme="${mode}"] { ${body} }`;
};

/** The CSS of both modes; "" when nothing is overridden. */
export function themeOverrideCss(o: ThemeOverrides): string {
  return [rule("dark", o.dark), rule("light", o.light)].filter(Boolean).join("\n");
}

export const OVERRIDE_STYLE_ID = "x-theme-overrides";

type StyleDoc = Pick<Document, "head" | "getElementById" | "createElement">;

/** Upserts `<style id="x-theme-overrides">` at the end of head; removes it when there is nothing to paint. */
export function applyTokenOverrides(doc: StyleDoc, o: ThemeOverrides | null): void {
  const css = o ? themeOverrideCss(o) : "";
  const existing = doc.getElementById(OVERRIDE_STYLE_ID);
  if (css === "") {
    existing?.remove();
    return;
  }
  const el = existing ?? doc.createElement("style");
  el.id = OVERRIDE_STYLE_ID;
  el.textContent = css;
  // Moving it last keeps it after any style a later part of the app inserted.
  doc.head.appendChild(el);
}

function probeValue(doc: Document, mode: "dark" | "light", read: (style: CSSStyleDeclaration) => string): string {
  const probe = doc.createElement("div");
  probe.setAttribute("data-theme", mode);
  probe.setAttribute("aria-hidden", "true");
  probe.style.display = "none";
  doc.body.appendChild(probe);
  try {
    return read(doc.defaultView!.getComputedStyle(probe));
  } finally {
    probe.remove();
  }
}

/** The built-in value of every key for `mode`, read from computed styles through a hidden probe. */
export function readThemeColors(doc: Document, mode: "dark" | "light"): Required<ThemeColors> {
  const out: Record<string, string> = {};
  probeValue(doc, mode, (style) => {
    for (const spec of THEME_KEYS) out[spec.key] = normalizeHex(style.getPropertyValue(spec.vars[0]!).trim()) ?? "";
    return "";
  });
  return out as Required<ThemeColors>;
}

/** The built-in `--x-color-on-accent` for `mode` (not editable; the contrast list reads it). */
export function readOnAccent(doc: Document, mode: "dark" | "light"): string {
  return normalizeHex(probeValue(doc, mode, (style) => style.getPropertyValue("--x-color-on-accent").trim())) ?? "";
}

function channels(hex: string): [number, number, number] | null {
  const h = normalizeHex(hex);
  if (!h) return null;
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(c: [number, number, number]): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG 2.x contrast ratio; 1 when one side does not parse. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [channels(a), channels(b)];
  if (!x || !y) return 1;
  const [la, lb] = [luminance(x), luminance(y)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface ContrastPair {
  fg: string;
  bg: string;
  min: 3 | 4.5;
}

const SURFACES = ["surface-0", "surface-1", "surface-2", "surface-3", "term"] as const;

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...(["text-1", "text-2"] as const).flatMap((fg) => SURFACES.map((bg): ContrastPair => ({ fg, bg, min: 4.5 }))),
  { fg: "text-3", bg: "surface-1", min: 3 },
  { fg: "on-accent", bg: "accent", min: 4.5 },
  ...(["accent", "ok", "warn", "danger"] as const).map((fg): ContrastPair => ({ fg, bg: "surface-1", min: 3 })),
];

export interface ContrastIssue extends ContrastPair {
  /** Rounded to 2 places. */
  ratio: number;
}

/** The pairs under their minimum for `colors` (every key; `extra` has the on-accent colour). */
export function contrastIssues(colors: Required<ThemeColors>, extra: { "on-accent": string }): ContrastIssue[] {
  const all: Record<string, string> = { ...colors, ...extra };
  const out: ContrastIssue[] = [];
  for (const pair of CONTRAST_PAIRS) {
    const fg = all[pair.fg];
    const bg = all[pair.bg];
    if (!fg || !bg) continue;
    const ratio = Math.round(contrastRatio(fg, bg) * 100) / 100;
    if (ratio < pair.min) out.push({ ...pair, ratio });
  }
  return out;
}
