import type { JSX, ReactNode } from "react";
import type { DocEntry, StaleDoc } from "@/api";
import { useI18n } from "@/i18n";

function StaleMark(props: { doc: StaleDoc | undefined }): JSX.Element | null {
  const { t } = useI18n();
  if (props.doc === undefined) return null;
  const { state, count } = props.doc;
  return (
    <span className="docitem-stale" data-state={state} title={t(`sidebar.markTitle.${state}`, { count })}>
      {t(`sidebar.mark.${state}`)}
    </span>
  );
}

export const NEW_DOC_SHORTCUT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘N" : "Ctrl+N";

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

// Root docs first, then folders by path, so the tree reads top-down.
function groupByFolder(docs: DocEntry[]): [string, DocEntry[]][] {
  const groups = new Map<string, DocEntry[]>();
  for (const doc of docs) {
    const folder = folderOf(doc.path);
    groups.set(folder, [...(groups.get(folder) ?? []), doc]);
  }
  return [...groups].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

export function Sidebar(props: {
  docs: DocEntry[];
  activePath: string | null;
  // Docs whose `covers` need a look; the rest get no mark.
  stale?: StaleDoc[];
  onOpen(path: string): void;
  onNew(): void;
  // The new-doc form, shown under the heading while it is open.
  newDoc?: ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  const marks = new Map((props.stale ?? []).map((s) => [s.path, s]));
  return (
    <nav className="pane" aria-label={t("sidebar.title")}>
      <div className="pane-head">
        <span>{t("sidebar.title")}</span>
        <span className="pane-tools">
          <span className="pane-count">{t("sidebar.count", { count: props.docs.length })}</span>
          <button
            type="button"
            className="pane-action"
            title={t("newDoc.title", { shortcut: NEW_DOC_SHORTCUT })}
            aria-label={t("newDoc.title", { shortcut: NEW_DOC_SHORTCUT })}
            onClick={props.onNew}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </span>
      </div>
      {props.newDoc}
      {props.docs.length === 0 && !props.newDoc && <p className="pane-empty">{t("sidebar.empty")}</p>}
      {groupByFolder(props.docs).map(([folder, docs]) => (
        <section key={folder} className="docgroup">
          {folder && <h2 className="docgroup-title">{folder}/</h2>}
          <ul className="doclist">
            {docs.map((doc) => (
              <li key={doc.path}>
                <button
                  type="button"
                  className="docitem"
                  title={doc.path}
                  aria-current={doc.path === props.activePath ? "page" : undefined}
                  disabled={doc.skipped !== null}
                  onClick={() => props.onOpen(doc.path)}
                >
                  <span className="docitem-line">
                    <svg
                      className="docitem-icon"
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                      <path d="M14 3v5h5" />
                    </svg>
                    <span className="docitem-title">{doc.title}</span>
                    <StaleMark doc={marks.get(doc.path)} />
                  </span>
                  {doc.skipped && <span className="docitem-note">{t(`skip.${doc.skipped}`)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
