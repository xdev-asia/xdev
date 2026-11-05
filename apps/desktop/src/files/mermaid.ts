/** Draws mermaid source to an SVG string. `theme` is mermaid's `themeVariables`. */
export type MermaidRender = (id: string, src: string, theme: Record<string, string>) => Promise<string>;

/** The default renderer: mermaid is loaded on first use, so it stays out of the main bundle. */
let initializedWith: string | null = null;
export const renderMermaid: MermaidRender = async (id, src, theme) => {
  const { default: mermaid } = await import("mermaid");
  // Initializing resets mermaid's config, so do it when the theme changed, not for every diagram.
  const key = JSON.stringify(theme);
  if (key !== initializedWith) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: theme });
    initializedWith = key;
  }
  const { svg } = await mermaid.render(id, src);
  return svg;
};

const VARS: Record<string, string> = {
  background: "--x-color-bg",
  primaryColor: "--x-color-panel",
  primaryTextColor: "--x-color-ink",
  primaryBorderColor: "--x-color-line",
  secondaryColor: "--x-color-surface",
  tertiaryColor: "--x-color-bg",
  lineColor: "--x-color-muted",
  textColor: "--x-color-ink",
  fontFamily: "--x-font-mono",
};

/** Mermaid theme variables taken from the app's CSS variables, so both themes are followed. */
export function mermaidTheme(read: (name: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, name] of Object.entries(VARS)) {
    const value = read(name).trim();
    if (value) out[key] = value;
  }
  return out;
}

export interface MermaidLabels {
  invalid: string;
  error: (message: string) => string;
  expand: string;
}

interface Slot {
  getAttribute(name: string): string | null;
  innerHTML: string;
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let counter = 0;

/** Draws every `.md-mermaid` placeholder of `root`. The returned cleanup drops diagrams that arrive late. */
export function fillMermaid(
  root: { querySelectorAll(selector: string): ArrayLike<Slot> },
  opts: { render: MermaidRender; theme: Record<string, string>; labels: MermaidLabels },
): () => void {
  let live = true;
  for (const slot of Array.from(root.querySelectorAll(".md-mermaid[data-src]"))) {
    const src = slot.getAttribute("data-src") ?? "";
    opts
      .render(`md-mermaid-${++counter}`, src, opts.theme)
      .then((svg) => {
        if (!live) return;
        slot.innerHTML = `${svg}<button type="button" class="btn-secondary md-mermaid-expand">${escapeHtml(opts.labels.expand)}</button>`;
      })
      .catch((e: unknown) => {
        if (!live) return;
        const message = e instanceof Error ? e.message : String(e);
        slot.innerHTML = `<p class="md-mermaid-invalid"><strong>${escapeHtml(opts.labels.invalid)}</strong><br>${escapeHtml(opts.labels.error(message))}</p>`;
      });
  }
  return () => void (live = false);
}
