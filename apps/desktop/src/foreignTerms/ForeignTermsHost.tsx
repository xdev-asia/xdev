import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api, SessionRow } from "@/api";
import { ForeignTermsDialog } from "./ForeignTermsDialog";
import { onForeignTermsOpen } from "./foreignTermsEvents";

export interface ForeignTermsHostProps {
  api: Pick<Api, "foreignTermsScan" | "agentSessions">;
  onOpenFolder(path: string): void;
  onResume(row: SessionRow): void;
}

/** Opens "Terminals on this machine" when the palette or the Stats page asks; an action closes it. */
export function ForeignTermsHost({ api, onOpenFolder, onResume }: ForeignTermsHostProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  useEffect(() => onForeignTermsOpen(() => setOpen(true)), []);
  if (!open) return null;
  return (
    <ForeignTermsDialog
      api={api}
      onClose={() => setOpen(false)}
      onOpenFolder={(path) => {
        setOpen(false);
        onOpenFolder(path);
      }}
      onResume={(row) => {
        setOpen(false);
        onResume(row);
      }}
    />
  );
}
