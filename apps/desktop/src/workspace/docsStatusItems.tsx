import type { ReactNode } from "react";
import type { DocsStatus } from "@/docs/types";
import type { DocsSection } from "@/shell/places";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The footer segment for Docs: stale docs, the folder, the doc count and the changes. It shows only while Docs is the view. */
export function docsStatusItems(s: DocsStatus & { folder: string | null }, t: T, onOpen: (section: DocsSection) => void): ReactNode[] {
  if (s.folder === null) return [<span key="docs-none">{t("status.noVault")}</span>];
  return [
    s.stale > 0 ? (
      <button key="docs-stale" type="button" className="ws-footer-link" data-action="docs-stale" onClick={() => onOpen("docs")}>
        <span className="ws-dot" data-tone="warn" aria-hidden="true" />
        {t("status.stale", { count: s.stale })}
      </button>
    ) : null,
    <span key="docs-folder" className="ws-mono">{s.folder}</span>,
    <span key="docs-count">{t("sidebar.count", { count: s.docs })}</span>,
    s.changes === null ? (
      <span key="docs-changes">{t("status.untracked")}</span>
    ) : (
      <button key="docs-changes" type="button" className="ws-footer-link" data-action="docs-changes" onClick={() => onOpen("changes")}>
        {t("status.changes", { count: s.changes })}
      </button>
    ),
  ];
}
