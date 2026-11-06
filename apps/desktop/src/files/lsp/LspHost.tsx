import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type LspSymbol } from "@/api";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import "@/styles/lsp.css";
import { registerEditorPlugin } from "../editorPlugins";
import { fileTabs } from "../fileTabs";
import { openFile } from "../openFile";
import { applyWorkspaceEdit } from "./applyEdit";
import { DefinitionPicker } from "./DefinitionPicker";
import { subscribeDiagnostics } from "./diagnosticsStore";
import { DocSync } from "./docSync";
import { askLsp, onLspAsk, type LspAsk } from "./lspEvents";
import { lspPlugin } from "./lspExtension";
import { RenameDialog } from "./RenameDialog";
import { SymbolDialog } from "./SymbolDialog";

type Shown = Exclude<LspAsk, { kind: "restart" }>;

/** Mounted once: keeps the servers' documents in step with the editors, takes their diagnostics, and shows the dialogs the editors ask for. */
export function LspHost({ api }: { api: Api }): JSX.Element | null {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const sync = useRef<DocSync | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);

  useEffect(() => {
    const docs = new DocSync(api);
    sync.current = docs;
    const restart = (worktree: string) =>
      api.lspRestart(worktree).then(
        () => docs.retry(worktree),
        (e: unknown) => void pushToast({ id: "lsp-note", text: tRef.current(`error.${toApiError(e).code}`) }),
      );
    const stop = subscribeDiagnostics(api, { t: () => tRef.current, restart: (worktree) => void restart(worktree) });
    const stopAsk = onLspAsk((ask) => {
      if (ask.kind === "restart") void restart(ask.worktree);
      else setShown(ask);
    });
    return () => {
      stopAsk();
      stop();
      docs.dispose();
      sync.current = null;
    };
  }, [api]);

  useEffect(
    () =>
      registerEditorPlugin(
        "lsp",
        lspPlugin({ api, t, retry: (worktree) => sync.current?.retry(worktree), open: openFile, ask: askLsp }),
      ),
    [api, t],
  );

  const close = () => setShown(null);
  if (!shown) return null;
  if (shown.kind === "rename") {
    const { worktree, rel, pos } = shown;
    return (
      <RenameDialog
        name={shown.name}
        onCancel={close}
        onRename={(newName) => {
          close();
          api.lspRename(worktree, rel, pos, newName).then(
            (edit) => applyWorkspaceEdit(edit, { worktree, store: fileTabs, api, t: tRef.current }),
            (e: unknown) => {
              const code = toApiError(e).code;
              pushToast({ id: "lsp-note", text: code === "lsp_unsupported" ? tRef.current("lsp.rename.cannot") : tRef.current(`error.${code}`) });
            },
          );
        }}
      />
    );
  }
  if (shown.kind === "definitions") {
    const { worktree } = shown;
    return <DefinitionPicker at={shown.at} targets={shown.targets} onClose={close} onPick={(target) => openFile({ worktree, rel: target.rel, line: target.line, column: target.column })} />;
  }
  const { worktree } = shown;
  const open = (symbol: LspSymbol) => {
    close();
    openFile({ worktree, rel: symbol.rel, line: symbol.range.start.line + 1, column: symbol.range.start.character + 1 });
  };
  return <SymbolDialog api={api} worktree={worktree} onOpen={open} onClose={close} />;
}
