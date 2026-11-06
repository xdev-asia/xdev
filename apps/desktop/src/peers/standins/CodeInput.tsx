import type { JSX } from "react";

// Stand-in for `CodeInput` of lane `peers-app-ui`, with the same props. Swap the import for
// `@xdev-asia/ui` once its pin lands; delete this file then.
export interface CodeInputProps {
  /** 10 for a pairing code, 6 for a SAS style code. */
  length: number;
  groupSize?: number;
  /** The normalised value, without separators. */
  value: string;
  onChange(value: string): void;
  onComplete?(value: string): void;
  alphabet?: "crockford" | "digits";
  /** The accessible name. */
  label: string;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}

const CROCKFORD = /[0-9A-HJKMNP-TV-Z]/;

/** Upper case, no spaces or dashes; Crockford maps O to 0 and I, L to 1 and drops the rest; cut to `length`. */
export function normalizeCode(raw: string, alphabet: "crockford" | "digits", length: number): string {
  let out = "";
  for (const ch of raw.toUpperCase()) {
    if (ch === " " || ch === "-") continue;
    const c = alphabet === "crockford" ? (ch === "O" ? "0" : ch === "I" || ch === "L" ? "1" : ch) : ch;
    if (alphabet === "crockford" ? CROCKFORD.test(c) : /[0-9]/.test(c)) out += c;
  }
  return out.slice(0, length);
}

/** The value as the field shows it: groups of `groupSize` joined with a dash. */
export function formatCode(value: string, groupSize: number): string {
  const groups: string[] = [];
  for (let i = 0; i < value.length; i += groupSize) groups.push(value.slice(i, i + groupSize));
  return groups.join("-");
}

export function CodeInput(props: CodeInputProps): JSX.Element {
  const { length, groupSize = length > 6 ? 5 : 3, value, alphabet = "crockford" } = props;
  return (
    <input
      type="text"
      className="peers-code-input"
      value={formatCode(value, groupSize)}
      aria-label={props.label}
      aria-invalid={props.invalid ? true : undefined}
      disabled={props.disabled}
      autoFocus={props.autoFocus}
      autoComplete="off"
      autoCapitalize="characters"
      spellCheck={false}
      // Room for the dashes between groups.
      maxLength={length + Math.ceil(length / groupSize) + 4}
      size={length + Math.ceil(length / groupSize)}
      onChange={(e) => {
        const next = normalizeCode(e.target.value, alphabet, length);
        props.onChange(next);
        if (next.length === length && value.length !== length) props.onComplete?.(next);
      }}
    />
  );
}
