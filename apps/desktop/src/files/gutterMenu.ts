// The menu of the editor's line-number gutter: copy a path to the line, or its hosted URL.
import type { EditorState } from "@codemirror/state";
import { toApiError, type Api } from "@/api";
import type { MenuItem } from "@/ui/ContextMenu";
import { pathToLine } from "./linkPath";

/** The main selection as the gutter needs it: lines are 1-based, `toCol` is the 1-based column of its end. */
export type GutterSelection = { fromLine: number; toLine: number; toCol: number };

/** The selection of `state` when it spans more than one line; null for a caret or a one-line selection. */
export function selectionOf(state: EditorState): GutterSelection | null {
  const main = state.selection.main;
  if (main.empty) return null;
  const from = state.doc.lineAt(main.from);
  const to = state.doc.lineAt(main.to);
  if (from.number === to.number) return null;
  return { fromLine: from.number, toLine: to.number, toCol: main.to - to.from + 1 };
}

/**
 * The lines a remote URL names: a click inside a multi-line selection names the selection, any
 * other click its own line. A selection that ends at column 1 of a line does not include that line.
 */
export function remoteRange(line: number, selection: GutterSelection | null): { line: number; endLine: number | null } {
  if (!selection) return { line, endLine: null };
  const end = selection.toCol === 1 ? selection.toLine - 1 : selection.toLine;
  if (line < selection.fromLine || line > end) return { line, endLine: null };
  return { line: selection.fromLine, endLine: end > selection.fromLine ? end : null };
}

type Translate = (key: string) => string;

export interface GutterContext {
  api: Pick<Api, "fileRemoteUrl">;
  worktree: string;
  rel: string;
  line: number;
  selection: GutterSelection | null;
  copyText(text: string): Promise<boolean>;
  toast(text: string): void;
  t: Translate;
  /** Windows prints `\`; the copied absolute path follows the OS. */
  win?: boolean;
}

/** The gutter's rows: Copy path to line, Copy relative path to line, Copy remote URL. */
export function gutterMenuItems(ctx: GutterContext): MenuItem[] {
  const copy = async (text: string): Promise<void> => {
    ctx.toast(ctx.t((await ctx.copyText(text)) ? "editor.gutter.copied" : "editor.gutter.copyFailed"));
  };
  return [
    { id: "copyPath", labelKey: "editor.gutter.copyPath", run: () => void copy(pathToLine(ctx.worktree, ctx.rel, ctx.line, ctx.win)) },
    { id: "copyRelPath", labelKey: "editor.gutter.copyRelPath", run: () => void copy(`${ctx.rel}:${ctx.line}`) },
    {
      id: "copyRemote",
      labelKey: "editor.gutter.copyRemote",
      run: () => {
        const { line, endLine } = remoteRange(ctx.line, ctx.selection);
        void ctx.api.fileRemoteUrl(ctx.worktree, ctx.rel, line, endLine).then(copy, (e: unknown) => {
          ctx.toast(ctx.t(toApiError(e).code === "no_web_remote" ? "editor.gutter.noRemote" : "editor.gutter.copyFailed"));
        });
      },
    },
  ];
}
