import type { JSX } from "react";
import { AnnotateDialog } from "./AnnotateDialog";
import { useCaptureHost, type CaptureHostProps } from "./useCaptureHost";

/**
 * Opens the annotate dialog for a screen capture, a pasted image or the palette's clipboard action,
 * and sends the result to an agent tab. Mounted once in the workspace shell.
 */
export function CaptureHost(props: CaptureHostProps): JSX.Element | null {
  const { session, discard, send } = useCaptureHost(props);
  if (!session) return null;
  return <AnnotateDialog key={session.path} image={session.image} onSend={send} onDiscard={discard} />;
}
