import { useState } from "react";
import type { Api, WorktreeView } from "@/api";
import type { ComposerRequest } from "@/composer/ComposerHost";
import type { MergeSource } from "@/workspace/MergeDialog";

/** The shell's small dialogs and popovers: which is open and what each was asked to show. */
export function useShellDialogs(api: Api) {
  const [composerAsk, setComposerAsk] = useState<ComposerRequest | null>(null);
  // The tabs whose output the merge dialog shows.
  const [mergeSources, setMergeSources] = useState<MergeSource[] | null>(null);
  // The About dialog (its version, once known) and the "quit and end terminals" confirmation.
  const [about, setAbout] = useState<string | null>(null);
  const [machine, setMachine] = useState("");
  const [boardOpen, setBoardOpen] = useState(false);
  const [confirmEndAll, setConfirmEndAll] = useState(false);
  const [renaming, setRenaming] = useState<WorktreeView | null>(null);
  const [checkingOut, setCheckingOut] = useState<WorktreeView | null>(null);
  const [parentFor, setParentFor] = useState<{ worktree: WorktreeView; candidates: WorktreeView[] } | null>(null);
  // The jump palette, and the settings section it asked for; a new `seq` is a new request.
  const [jumpOpen, setJumpOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  function openAbout(): void {
    void api.machineName().then(setMachine, () => setMachine(""));
    void api.appVersion().then(setAbout, () => setAbout(""));
  }

  return {
    composerAsk, setComposerAsk, mergeSources, setMergeSources, about, setAbout, machine, boardOpen, setBoardOpen, confirmEndAll, setConfirmEndAll,
    renaming, setRenaming, checkingOut, setCheckingOut, parentFor, setParentFor, jumpOpen, setJumpOpen, quickOpen, setQuickOpen, openAbout,
  };
}
