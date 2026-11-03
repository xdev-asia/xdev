import type { CSSProperties, JSX } from "react";
import type { PtyProfile } from "../api";
import { profileLetter, useProfiles } from "../agents/profileStore";

/** A letter mark on the profile's color; the name is always written next to it, so it is hidden from readers. */
export function AgentIcon(props: { profile: PtyProfile; size?: number }): JSX.Element {
  const { profile, size = 16 } = props;
  const { view } = useProfiles();
  // The mark scales from one custom property, so the letter stays in proportion.
  const style = { "--agent-size": `${size}px` } as CSSProperties;
  return (
    <span className="ws-agent" data-profile={profile} style={style} aria-hidden="true">
      {profileLetter(view, profile)}
    </span>
  );
}
