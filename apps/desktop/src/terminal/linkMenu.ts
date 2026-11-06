import type { Api, LinksTarget } from "@/api";
import { linkKeepsFocus, routeLink } from "@/browser/linkRouting";
import { toApiError } from "@/api";
import type { OpenFileRequest } from "@/files/openFile";
import type { MenuItem } from "@/ui/ContextMenu";
import { formatLocation } from "./fileLinks";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** What the link actions need; the terminal passes the real ones, tests pass fakes. */
export interface LinkDeps {
  api: Pick<Api, "fileOpenDefault" | "fileReveal" | "openUrl">;
  openFile(req: OpenFileRequest): void;
  copyText(text: string): Promise<boolean>;
  toast(text: string): void;
  t: Translate;
  mac: boolean;
  /** Opens Settings at the terminal link rows. */
  onSettings(): void;
  /** Gives the keyboard back to the terminal once a row has run. */
  focusTerminal(): void;
  /** Loads a web link in the worktree's browser tab; without it every link goes to the system. */
  openInPane?(url: string, keepFocus: boolean): void;
  /** The setting `browser.openLinksIn`. */
  linksTarget?(): LinksTarget;
}

/** A file link as the backend resolved it, with the text the terminal printed. */
export interface FileTarget {
  worktree: string;
  rel: string;
  line?: number;
  column?: number;
}

export interface LinkMenu {
  /** The line above the rows: the target, in full. */
  title: string;
  items: MenuItem[];
}

const SEP = (id: string): MenuItem => ({ id, labelKey: "", kind: "separator" });

function failed(deps: LinkDeps, e: unknown, what: string): void {
  deps.toast(deps.t("termLink.openFailed", { path: what }));
}

/** Opens the file in the editor at its line and column. */
export function openFileLink(target: FileTarget, deps: LinkDeps): void {
  deps.openFile({ worktree: target.worktree, rel: target.rel, ...(target.line !== undefined ? { line: target.line } : {}), ...(target.column !== undefined ? { column: target.column } : {}) });
}

/** Opens the file with the OS default app. A type outside the backend's allowlist is revealed in the file manager instead, with a toast. */
export function openDefaultLink(target: FileTarget, deps: LinkDeps): Promise<void> {
  return deps.api.fileOpenDefault(target.worktree, target.rel).catch((e: unknown) => {
    if (toApiError(e).code !== "denied") return failed(deps, e, target.rel);
    deps.toast(deps.t("termLink.denied"));
    return deps.api.fileReveal(target.worktree, target.rel).catch((err: unknown) => failed(deps, err, target.rel));
  });
}

/** Opens an http(s) URL in the system browser. */
/** Opens a web link where `browser.openLinksIn` says; `shift` (a Shift click) sends it to the other place. */
export function openUrlLink(url: string, deps: LinkDeps, shift = false): Promise<void> {
  const setting = deps.linksTarget?.() ?? "system";
  if (deps.openInPane && routeLink(setting, shift, url) === "pane") {
    deps.openInPane(url, linkKeepsFocus(setting, shift));
    return Promise.resolve();
  }
  return deps.api.openUrl(url).catch((e: unknown) => failed(deps, e, url));
}

// Runs a row, then hands the keyboard back to the terminal.
const then = (deps: LinkDeps, run: () => unknown) => () => {
  void Promise.resolve(run()).finally(() => deps.focusTerminal());
};

/** The menu a plain click on a file link shows. `shown` replaces the title and the copied text (an OSC 8 target is shown and copied as the program wrote it). */
export function fileLinkMenu(target: FileTarget, deps: LinkDeps, shown?: string): LinkMenu {
  const printed = shown ?? formatLocation(target.rel, target.line, target.column);
  const mac = deps.mac;
  return {
    title: printed,
    items: [
      { id: "open", labelKey: "termLink.open", chord: mac ? "⌘ Click" : "Ctrl+Click", run: then(deps, () => openFileLink(target, deps)) },
      { id: "openDefault", labelKey: "termLink.openDefault", chord: mac ? "⇧⌘ Click" : "Shift+Ctrl+Click", run: then(deps, () => openDefaultLink(target, deps)) },
      {
        id: "reveal",
        labelKey: "files.menu.reveal",
        run: then(deps, () => deps.api.fileReveal(target.worktree, target.rel).catch((e: unknown) => failed(deps, e, target.rel))),
      },
      SEP("sep1"),
      {
        id: "copyPath",
        labelKey: "termLink.copyPath",
        run: then(deps, async () => deps.toast(deps.t((await deps.copyText(printed)) ? "termLink.copiedPath" : "termLink.copyPathFailed"))),
      },
      { id: "settings", labelKey: "termLink.settings", run: then(deps, () => deps.onSettings()) },
    ],
  };
}

/** The menu a plain click on a URL shows; `raw` is what is copied, and is the title too. */
export function urlLinkMenu(raw: string, deps: LinkDeps): LinkMenu {
  return {
    title: raw,
    items: [
      { id: "openUrl", labelKey: "termLink.openUrl", chord: deps.mac ? "⌘ Click" : "Ctrl+Click", run: then(deps, () => openUrlLink(raw, deps)) },
      SEP("sep1"),
      {
        id: "copyLink",
        labelKey: "termLink.copyLink",
        run: then(deps, async () => deps.toast(deps.t((await deps.copyText(raw)) ? "termLink.copiedLink" : "termLink.copyLinkFailed"))),
      },
      { id: "settings", labelKey: "termLink.settings", run: then(deps, () => deps.onSettings()) },
    ],
  };
}
