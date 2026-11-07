import { Button, NavList, SearchInput, type NavListItem } from "@xdev-asia/ui";
import type { JSX, KeyboardEvent, ReactNode } from "react";
import type { SearchHit } from "@/api";
import { useI18n } from "@/i18n";
import type { DocsSection } from "@/shell/places";
import { DOCS_SEARCH_ID } from "./ids";
import { resultId, RESULTS_ID } from "./SearchPanel";

export type DocsNavSearch = {
  query: string;
  hits: SearchHit[];
  searching: boolean;
  error: string | null;
  active: number;
  onQuery(query: string): void;
  onKey(e: KeyboardEvent<HTMLInputElement>): void;
};

export type DocsNavProps = {
  sections: DocsSection[];
  section: DocsSection;
  onSection(section: DocsSection): void;
  /** `null` while the changes are unknown (loading, or the folder is not tracked). */
  changeCount: number | null;
  search: DocsNavSearch;
  canChangeFolder: boolean;
  onOpenFolder(): void;
  /** The folder sources. */
  vaultNav: ReactNode;
  /** The list for the section: the tree, the changes, or the hits while there is a query. */
  children: ReactNode;
};

const LABEL: Record<DocsSection, string> = { docs: "apps.docs", changes: "apps.changes", agents: "apps.agents" };

/** The one side list for Docs: folders, search, the section switch and the list for the section. */
export function DocsNav(props: DocsNavProps): JSX.Element {
  const { t } = useI18n();
  const { search } = props;
  const items: NavListItem[] = props.sections.map((id) => ({
    id,
    label: t(LABEL[id]),
    ...(id === "changes" && props.changeCount !== null ? { count: props.changeCount } : {}),
  }));
  const searching = search.query.trim() !== "";
  return (
    <div className="docs-nav">
      <div className="docs-nav-sources" role="group" aria-label={t("docsnav.sources")}>
        {props.vaultNav}
      </div>
      <Button variant="secondary" type="button" disabled={!props.canChangeFolder} onClick={props.onOpenFolder}>
        {t("docsnav.openFolder")}
      </Button>
      <SearchInput
        id={DOCS_SEARCH_ID}
        size="sm"
        value={search.query}
        placeholder={t("search.placeholder")}
        aria-label={t("search.label")}
        aria-controls={RESULTS_ID}
        aria-activedescendant={searching && search.hits[search.active] ? resultId(search.active) : undefined}
        onChange={(e) => search.onQuery(e.target.value)}
        onClear={() => search.onQuery("")}
        onKeyDown={search.onKey}
      />
      <NavList items={items} value={props.section} onSelect={(id) => props.onSection(id as DocsSection)} labels={{ nav: t("docsnav.sections") }} />
      {props.children}
    </div>
  );
}
