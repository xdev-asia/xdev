// Stand-in for @xdev-asia/ui ThemePreview; delete when the pin has it.
import type { JSX } from "react";

export interface ThemePreviewProps {
  /** The mode the card shows; the theme's overrides reach it through its own `data-theme`. */
  mode: "dark" | "light";
  title: string;
  sample: string;
  hint: string;
  button: string;
}

/** A small card of sample surfaces and text, painted by the same tokens as the app. */
export function ThemePreview(props: ThemePreviewProps): JSX.Element {
  return (
    <section className="theme-preview" data-theme={props.mode} aria-label={props.title} data-mode={props.mode}>
      <h5 className="theme-preview-title">{props.title}</h5>
      <p className="theme-preview-text">{props.sample}</p>
      <p className="theme-preview-hint">{props.hint}</p>
      <div className="theme-preview-row">
        <span className="theme-preview-button">{props.button}</span>
        <span className="theme-preview-dot" data-tone="ok" />
        <span className="theme-preview-dot" data-tone="warn" />
        <span className="theme-preview-dot" data-tone="danger" />
      </div>
    </section>
  );
}
