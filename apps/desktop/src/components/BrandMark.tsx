import type { JSX } from "react";
import { BrandMark as UiBrandMark, type BrandMarkProps } from "@xdev-asia/ui";

export type { BrandMarkSize } from "@xdev-asia/ui";

// The mark lives in xdev-ui. In the app chrome it always sits next to the product name, so it stays decorative.
export function BrandMark(props: Omit<BrandMarkProps, "label">): JSX.Element {
  return <UiBrandMark {...props} label="" />;
}
