// Stand-in for @xdev-asia/ui ColorField; delete when the pin has it.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { normalizeHex } from "@/ui/themeOverrides";

export interface ColorFieldProps {
  /** The token's name, shown as the label. */
  label: string;
  /** The colour in force: `#rrggbb`. */
  value: string;
  /** Whether a value of the theme replaces the built-in one. */
  overridden: boolean;
  /** Called with a valid `#rrggbb` only. */
  onChange(hex: string): void;
  onReset(): void;
  labels: { reset: string; picker: string; invalid: string };
  "data-key"?: string;
}

/** A colour swatch picker, a hex field and a reset button for one token. */
export function ColorField(props: ColorFieldProps): JSX.Element {
  const { label, value, overridden, labels } = props;
  const [text, setText] = useState(value);
  // The committed value moves (reset, mode switch): the text follows it.
  useEffect(() => setText(value), [value]);
  const bad = normalizeHex(text) === null;
  return (
    <div className="colour-field" data-key={props["data-key"]}>
      <label className="colour-field-name" htmlFor={`colour-${props["data-key"] ?? label}`}>
        {label}
      </label>
      <input
        type="color"
        className="colour-field-swatch"
        aria-label={labels.picker}
        value={normalizeHex(value) ?? ""}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <input
        id={`colour-${props["data-key"] ?? label}`}
        className="colour-field-hex"
        type="text"
        inputMode="text"
        spellCheck={false}
        autoComplete="off"
        maxLength={7}
        value={text}
        aria-invalid={bad}
        onChange={(e) => {
          setText(e.target.value);
          const hex = normalizeHex(e.target.value);
          if (hex) props.onChange(hex);
        }}
        onBlur={() => {
          if (bad) setText(value);
        }}
      />
      <button type="button" className="colour-field-reset" aria-label={labels.reset} title={labels.reset} disabled={!overridden} onClick={props.onReset}>
        <span aria-hidden="true">↺</span>
      </button>
      {bad && (
        <small className="error-text colour-field-error" role="alert">
          {labels.invalid}
        </small>
      )}
    </div>
  );
}
