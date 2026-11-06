import { completeAnyWord, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { nextDiagnostic, previousDiagnostic, lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, showPanel, ViewPlugin, type Panel } from "@codemirror/view";
import { toApiError, type Api, type LspCompletionItem, type LspDiagnostic, type LspLocation } from "@/api";
import { IS_MAC } from "@/platform";
import { pushToast } from "@/workspace/toastStore";
import type { EditorPlugin } from "../editorPlugins";
import type { OpenFileRequest } from "../openFile";
import { diagnostics as sharedDiagnostics, type DiagnosticsStore } from "./diagnosticsStore";
import { renderHover } from "./hoverMarkdown";
import { lspLanguageId } from "./languageIds";
import { lspStatus, type LspStatusStore } from "./lspStatus";
import type { LspAsk } from "./lspEvents";
import { fromLsp, toLsp } from "./positions";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** What the extensions need from the app; tests pass fakes. */
export interface LspDeps {
  api: Pick<Api, "lspHover" | "lspDefinition" | "lspCompletion" | "lspPrepareRename" | "lspTrust">;
  t: T;
  /** Opens the documents of a worktree again after Start. */
  retry(worktree: string): void;
  open(req: OpenFileRequest): void;
  ask(ask: LspAsk): void;
  diagnostics?: DiagnosticsStore;
  status?: LspStatusStore;
  /** True when the Mod key of a click is Cmd. */
  mac?: boolean;
}

const WORD = /[\w$]*/;
const SEVERITY: Record<number, Diagnostic["severity"]> = { 1: "error", 2: "warning", 3: "info", 4: "info" };

// LSP CompletionItemKind to the type names CodeMirror draws an icon for.
const KIND: Record<number, string> = {
  1: "text", 2: "method", 3: "function", 4: "class", 5: "property", 6: "variable", 7: "class", 8: "interface",
  9: "namespace", 10: "property", 11: "keyword", 12: "constant", 13: "enum", 14: "keyword", 15: "text", 16: "constant",
  17: "text", 18: "text", 19: "text", 20: "enum", 21: "constant", 22: "type", 23: "property", 24: "keyword", 25: "type",
};

/** The completion source of one file: the server's items, `from` at the item range or the word start. */
export function lspCompletionSource(deps: LspDeps, worktree: string, rel: string) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const word = ctx.matchBefore(WORD);
    const afterDot = ctx.state.sliceDoc(Math.max(0, ctx.pos - 1), ctx.pos) === ".";
    if (!ctx.explicit && !afterDot && (!word || word.from === word.to)) return null;
    let list;
    try {
      list = await deps.api.lspCompletion(worktree, rel, toLsp(ctx.state.doc, ctx.pos));
    } catch {
      return null;
    }
    if (ctx.aborted) return null;
    const wordFrom = word ? word.from : ctx.pos;
    const first = list.items.find((i) => i.range);
    const from = first?.range ? Math.min(fromLsp(ctx.state.doc, first.range.start), ctx.pos) : wordFrom;
    const options = list.items.map((item): Completion => option(ctx, item, from));
    return { from, options, ...(list.incomplete ? {} : { validFor: /^[\w$]*$/ }) };
  };
}

function option(ctx: CompletionContext, item: LspCompletionItem, from: number): Completion {
  const own = item.range ? Math.min(fromLsp(ctx.state.doc, item.range.start), ctx.pos) : from;
  const out: Completion = { label: item.label, type: item.kind !== null ? KIND[item.kind] : undefined, detail: item.detail ?? undefined };
  if (own === from) {
    out.apply = item.insertText;
  } else {
    out.apply = (view, _c, _from, to) => view.dispatch({ changes: { from: own, to, insert: item.insertText }, selection: { anchor: own + item.insertText.length } });
  }
  return out;
}

const setTrust = StateEffect.define<boolean>();

/** The extensions of the language server features for one file; none for a file no server handles. */
export function lspPlugin(deps: LspDeps): EditorPlugin {
  return (ctx) => {
    if (lspLanguageId(ctx.rel) === null) return [];
    const { worktree, rel } = ctx;
    const store = deps.diagnostics ?? sharedDiagnostics;
    const status = deps.status ?? lspStatus;
    const { t } = deps;
    const toast = (text: string) => void pushToast({ id: "lsp-note", text });
    const fail = (e: unknown) => toast(t(`error.${toApiError(e).code}`));

    const pushDiagnostics = (view: EditorView): void => {
      const doc = view.state.doc;
      const mapped = store.get(worktree, rel).map((d: LspDiagnostic): Diagnostic => {
        const from = fromLsp(doc, d.range.start);
        return { from, to: Math.max(from, fromLsp(doc, d.range.end)), severity: SEVERITY[d.severity] ?? "info", message: d.message, source: d.source ?? undefined };
      });
      view.dispatch(setDiagnostics(view.state, mapped));
    };
    // Pushed by the server, so no polling: the plugin listens to the store and sets the diagnostics.
    const diagnosticsPlugin = ViewPlugin.define((view) => {
      let live = true;
      queueMicrotask(() => live && pushDiagnostics(view));
      const off = store.subscribe((w, r) => w === worktree && r === rel && pushDiagnostics(view));
      return {
        destroy() {
          live = false;
          off();
        },
      };
    });

    const definitionAt = async (view: EditorView, pos: number, at?: { x: number; y: number }): Promise<void> => {
      let found: LspLocation[];
      try {
        found = await deps.api.lspDefinition(worktree, rel, toLsp(view.state.doc, pos));
      } catch (e) {
        return fail(e);
      }
      if (found.length === 0) return toast(t("lsp.definition.none"));
      const inside = found.filter((l) => l.rel !== null);
      if (inside.length === 0) return toast(t("lsp.definition.outside"));
      const targets = inside.map((l) => ({ rel: l.rel as string, line: l.range.start.line + 1, column: l.range.start.character + 1 }));
      if (targets.length === 1) return deps.open({ worktree, rel: targets[0].rel, line: targets[0].line, column: targets[0].column });
      const caret = view.coordsAtPos(pos);
      deps.ask({ kind: "definitions", worktree, at: at ?? { x: caret?.left ?? 0, y: caret?.bottom ?? 0 }, targets });
    };

    const rename = async (view: EditorView): Promise<void> => {
      const pos = toLsp(view.state.doc, view.state.selection.main.head);
      let range;
      try {
        range = await deps.api.lspPrepareRename(worktree, rel, pos);
      } catch (e) {
        if (toApiError(e).code === "lsp_unsupported") return toast(t("lsp.rename.cannot"));
        return fail(e);
      }
      if (!range) return toast(t("lsp.rename.cannot"));
      const name = view.state.sliceDoc(fromLsp(view.state.doc, range.start), fromLsp(view.state.doc, range.end));
      deps.ask({ kind: "rename", worktree, rel, pos: range.start, name });
    };

    const trustPanel = (): Panel => {
      const dom = document.createElement("div");
      dom.className = "lsp-trust";
      dom.setAttribute("role", "region");
      dom.setAttribute("aria-label", t("lsp.trust.label"));
      const text = document.createElement("p");
      text.className = "lsp-trust-text";
      text.textContent = t("lsp.trust.text");
      const start = document.createElement("button");
      start.type = "button";
      start.className = "btn-secondary";
      start.textContent = t("lsp.trust.start");
      start.addEventListener("click", () => {
        deps.api.lspTrust(worktree, true).then(() => {
          status.setAsking(worktree, false);
          deps.retry(worktree);
        }, fail);
      });
      const later = document.createElement("button");
      later.type = "button";
      later.className = "btn-secondary";
      later.textContent = t("lsp.trust.later");
      later.addEventListener("click", () => status.hide(worktree));
      dom.append(text, start, later);
      return { dom, top: true };
    };
    const trust = StateField.define<boolean>({
      create: () => status.asking(worktree),
      update: (on, tr) => tr.effects.reduce((acc, e) => (e.is(setTrust) ? e.value : acc), on),
      // Only the first view of a file asks.
      provide: (f) => showPanel.from(f, (on) => (on && !ctx.secondary ? trustPanel : null)),
    });
    const trustWatcher = ViewPlugin.define((view) => {
      const off = status.subscribe(() => {
        if (status.asking(worktree) !== view.state.field(trust)) queueMicrotask(() => view.dispatch({ effects: setTrust.of(status.asking(worktree)) }));
      });
      return { destroy: off };
    });

    const modKey = (e: MouseEvent) => ((deps.mac ?? IS_MAC) ? e.metaKey : e.ctrlKey);

    const parts: Extension[] = [
      lintGutter(),
      diagnosticsPlugin,
      keymap.of([
        { key: "F8", run: nextDiagnostic },
        { key: "Shift-F8", run: previousDiagnostic },
        { key: "F12", run: (view) => (void definitionAt(view, view.state.selection.main.head), true) },
        { key: "F2", run: (view) => (void rename(view), true) },
      ]),
      EditorView.domEventHandlers({
        mousedown(e, view) {
          if (e.button !== 0 || !modKey(e)) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos === null) return false;
          e.preventDefault();
          void definitionAt(view, pos, { x: e.clientX, y: e.clientY });
          return true;
        },
      }),
      hoverTooltip(async (view, pos) => {
        try {
          const hover = await deps.api.lspHover(worktree, rel, toLsp(view.state.doc, pos));
          if (!hover || hover.markdown.trim() === "") return null;
          const from = hover.range ? fromLsp(view.state.doc, hover.range.start) : pos;
          const to = hover.range ? fromLsp(view.state.doc, hover.range.end) : pos;
          return { pos: from, end: to, above: true, create: () => ({ dom: renderHover(hover.markdown) }) };
        } catch {
          return null;
        }
      }),
      // basicSetup already has autocompletion(); the sources join it through the language data.
      EditorState.languageData.of(() => [{ autocomplete: lspCompletionSource(deps, worktree, rel) }, { autocomplete: completeAnyWord }]),
      trust,
      trustWatcher,
    ];
    return parts;
  };
}
