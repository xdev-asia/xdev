import type { Api, LspTextEdit, LspWorkspaceEdit } from "@/api";
import { pushToast } from "@/workspace/toastStore";
import type { FileTabs } from "../fileTabs";
import { lineStarts, offsetIn } from "./positions";

/** The most files one rename may change. */
export const MAX_RENAME_FILES = 50;

type T = (key: string, vars?: Record<string, string | number>) => string;

/** `text` with the edits applied. They are sorted by start and applied from the end, so every range reads the original text. */
export function applyTextEdits(text: string, edits: readonly LspTextEdit[]): string {
  const starts = lineStarts(text);
  const spans = edits
    .map((e, i) => ({ i, from: offsetIn(text, starts, e.range.start), to: offsetIn(text, starts, e.range.end), insert: e.newText }))
    .sort((a, b) => b.from - a.from || b.i - a.i);
  let out = text;
  for (const s of spans) out = out.slice(0, s.from) + s.insert + out.slice(Math.max(s.from, s.to));
  return out;
}

/**
 * Puts a rename's edits into the file buffers. Nothing is written to disk: the files stay unsaved
 * for the person to review. A file that is not open is read and opened with the edits in it.
 */
export async function applyWorkspaceEdit(
  edit: LspWorkspaceEdit,
  ctx: { worktree: string; store: FileTabs; api: Pick<Api, "fileRead">; t: T },
): Promise<void> {
  const { worktree, store, api, t } = ctx;
  if (edit.files.length > MAX_RENAME_FILES) {
    pushToast({ id: "lsp-rename", text: t("lsp.rename.tooMany", { n: edit.files.length }) });
    return;
  }
  let changed = 0;
  for (const file of edit.files) {
    const entry = store.get(worktree, file.rel);
    if (entry && entry.status === "ready" && entry.kind === "text") {
      store.edit(worktree, file.rel, applyTextEdits(entry.text, file.edits));
      changed++;
      continue;
    }
    if (entry && entry.status === "loading") continue;
    try {
      const read = await api.fileRead(worktree, file.rel);
      if (read.kind !== "text") continue;
      // Open, load and edit in one step, so the file view never loads the file a second time over the edits.
      store.open(worktree, file.rel);
      store.loaded(worktree, file.rel, read);
      store.edit(worktree, file.rel, applyTextEdits(read.text ?? "", file.edits));
      changed++;
    } catch {
      // A file that cannot be read is left out of the count.
    }
  }
  const note = edit.skipped > 0 ? ` ${t("lsp.rename.skipped", { skipped: edit.skipped })}` : "";
  pushToast({ id: "lsp-rename", text: t("lsp.rename.done", { files: changed }) + note });
}
