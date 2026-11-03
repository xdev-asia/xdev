import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type DocLink } from "@/api";
import { useI18n } from "@/i18n";

// Docs that link to `path`, as the index sees them on disk (unsaved edits elsewhere do not count yet).
export function Backlinks(props: {
  api: Api;
  path: string;
  // Bumped on every vault change, since any doc may have gained or lost a link here.
  revision: number;
  onOpen(path: string): void;
}): JSX.Element | null {
  const { t } = useI18n();
  const { api, path } = props;
  const [links, setLinks] = useState<{ path: string; found: DocLink[] }>();
  const [error, setError] = useState<ApiError["code"]>();

  useEffect(() => {
    let stale = false;
    api.backlinks(path).then(
      (found) => {
        if (stale) return;
        setLinks({ path, found });
        setError(undefined);
      },
      (e: unknown) => !stale && setError(toApiError(e).code),
    );
    return () => {
      stale = true;
    };
  }, [api, path, props.revision]);

  // Until the first answer for this doc arrives, showing the previous doc's links would be wrong.
  const found = links?.path === path ? links.found : undefined;
  if (found === undefined && error === undefined) return null;
  return (
    <section className="backlinks" aria-label={t("backlinks.label")}>
      <div className="pane-head">
        <span>{t("backlinks.title", { count: found?.length ?? 0 })}</span>
      </div>
      {error !== undefined ? (
        <p className="pane-empty">{t(`error.${error}`)}</p>
      ) : found === undefined || found.length === 0 ? (
        <p className="pane-empty">{t("backlinks.empty")}</p>
      ) : (
        <ul className="backlinks-list">
          {found.map((link) => (
            <li key={link.path}>
              <button type="button" className="backlink" title={link.path} onClick={() => props.onOpen(link.path)}>
                <span className="backlink-title">{link.title}</span>
                <span className="backlink-path">{link.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
