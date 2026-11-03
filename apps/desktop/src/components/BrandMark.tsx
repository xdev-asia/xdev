import type { JSX } from "react";

export type BrandMarkSize = 16 | 18 | 20 | 64;

// The flat xDev mark (docs/brand/xdev-mark.svg), inlined so it takes its colour from the surrounding CSS
// (`color`, set from the accent token) and stays sharp at every size. The geometry is whole units on a 24 grid.
export function BrandMark(props: { size: BrandMarkSize; className?: string }): JSX.Element {
  return (
    <svg
      className={props.className}
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M0 3H6L15 12L6 21H0L9 12Z" />
      <path d="M12 18H21V21H12Z" />
    </svg>
  );
}
