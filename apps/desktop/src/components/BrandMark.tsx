import type { JSX } from "react";

export type BrandMarkSize = 16 | 18 | 20 | 64;

// The flat xDev mark (docs/brand/xdev-mark.svg), inlined so the × takes its colour from the surrounding CSS
// (`color`, set from the accent token) and stays sharp at every size. The cursor is always the agent orange.
export function BrandMark(props: { size: BrandMarkSize; className?: string }): JSX.Element {
  return (
    <svg
      className={props.className}
      width={props.size}
      height={props.size}
      viewBox="250 225 550 550"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M316 368L580 632M580 368L316 632" stroke="currentColor" strokeWidth={112} strokeLinecap="round" fill="none" />
      <rect x={640} y={580} width={150} height={64} rx={18} style={{ fill: "var(--brand-agent)" }} />
    </svg>
  );
}
