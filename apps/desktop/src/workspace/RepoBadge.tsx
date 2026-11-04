import type { JSX } from "react";
import type { RepoView } from "@/api";
import { REPO_COLORS, hexInk, isHexColor, widenHex } from "./repoIdentity";

/** The colour and icon of a project as a small square: the emoji, else the first letter of the short name. */
export function RepoBadge(props: { repo: Pick<RepoView, "shortName" | "color" | "icon">; size?: "sm" | "md" }): JSX.Element {
  const { shortName, color, icon } = props.repo;
  const preset = color !== null && (REPO_COLORS as readonly string[]).includes(color) ? color : null;
  // A custom hex is the one literal colour: data the person typed, drawn as the badge fill only.
  const hex = color !== null && isHexColor(color) ? widenHex(color) : null;
  const glyph = icon?.kind === "emoji" ? icon.value : ([...shortName][0] ?? "?").toUpperCase();
  const classes = ["ws-badge", `ws-badge-${props.size ?? "sm"}`, preset ? `ws-badge-tag-${preset}` : ""].filter(Boolean).join(" ");
  return (
    <span className={classes} data-color={preset ?? (hex ? "custom" : "none")} data-ink={hex ? hexInk(hex) : undefined} style={hex ? { background: hex } : undefined} aria-hidden="true">
      {glyph}
    </span>
  );
}
