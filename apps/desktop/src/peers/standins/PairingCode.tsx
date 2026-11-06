import { IconButton } from "@xdev-asia/ui";
import type { JSX } from "react";

// Stand-in for `PairingCode` of lane `peers-app-ui`, with the same props. Swap the import for
// `@xdev-asia/ui` once its pin lands; delete this file then.
export interface PairingCodeProps {
  /** For example `7K4QM-2XD9P` or `482 913`. */
  value: string;
  /** Characters per group; default 5 (the SAS uses 3). */
  groupSize?: number;
  /** The accessible name. */
  label?: string;
  /** Shows a copy button when set. */
  copyLabel?: string;
  onCopy?: () => void;
  size?: "md" | "lg";
}

/** The code without its separators, cut into groups. */
export function codeGroups(value: string, groupSize: number): string[] {
  const chars = value.replace(/[\s-]/g, "");
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += groupSize) groups.push(chars.slice(i, i + groupSize));
  return groups;
}

export function PairingCode({ value, groupSize = 5, label, copyLabel, onCopy, size = "lg" }: PairingCodeProps): JSX.Element {
  return (
    <div className="peers-code" data-size={size} role="group" aria-label={label}>
      <span className="peers-code-value" aria-live="polite">
        <span className="peers-code-groups" aria-hidden="true">
          {codeGroups(value, groupSize).map((g, i) => (
            <span key={i} className="peers-code-group">
              {g}
            </span>
          ))}
        </span>
        <span className="peers-sr">{value}</span>
      </span>
      {copyLabel ? <IconButton icon="copy" label={copyLabel} onClick={onCopy} /> : null}
    </div>
  );
}
