import { SearchPicker } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type Issue, type PrSummary, type WorkItem } from "@/api";
import { useI18n } from "@/i18n";
import { issueQuery, prQuery } from "@/issues/issueStart";
import { itemKindOf } from "./workItemInput";

export const LINKED_DEBOUNCE_MS = 300;
const LINKED_LIMIT = 10;
const REASONS: readonly string[] = ["gh_missing", "gh_auth", "not_github"];

/** What a row came from, so a caller can start work from the issue or pull request itself. */
export type LinkedSource = { kind: "issue"; issue: Issue } | { kind: "pr"; pr: PrSummary };
export type LinkedRow = { id: string; title: string; meta: string; item: WorkItem; source: LinkedSource };

/** One row per match: pull requests first, then issues; the id is the link so a pick maps back to it. */
export function linkedRows(issues: Issue[], prs: PrSummary[]): LinkedRow[] {
  return [
    ...prs.map((p) => ({ id: p.url, title: p.title, meta: `#${p.number} · ${p.state}`, item: { kind: "pr", url: p.url, title: p.title } as WorkItem, source: { kind: "pr", pr: p } as LinkedSource })),
    ...issues.map((i) => ({ id: i.url, title: i.title, meta: `#${i.number} · ${i.state}`, item: { kind: "issue", url: i.url, title: i.title } as WorkItem, source: { kind: "issue", issue: i } as LinkedSource })),
  ];
}

/** A pasted GitHub issue or pull request link as a work item, with the kind read from the link; else null. */
export function pastedItem(text: string): WorkItem | null {
  const url = text.trim();
  const kind = itemKindOf(url);
  return kind === null ? null : { kind, url, title: null };
}

/** Search the repo's issues and pull requests, or paste a link, and pick one as the linked work. */
export function LinkedWorkSearch(props: { api: Api; repoId: string; onPick(item: WorkItem, source: LinkedSource | null): void }): JSX.Element {
  const { api, repoId, onPick } = props;
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<LinkedRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (draft === query) return;
    const id = setTimeout(() => setQuery(draft), LINKED_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [draft, query]);

  useEffect(() => {
    const search = query.trim();
    if (search === "" || pastedItem(search)) {
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    Promise.all([
      api.issuesList(repoId, issueQuery({ search, limit: LINKED_LIMIT })),
      api.prsList(repoId, prQuery({ search, limit: LINKED_LIMIT })),
    ])
      .then(([issues, prs]) => {
        if (!current) return;
        setRows(linkedRows(issues, prs));
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!current) return;
        setError(toApiError(e));
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, repoId, query]);

  const pasted = pastedItem(draft);
  const items = pasted
    ? [{ id: pasted.url, title: pasted.url, meta: t(`workItem.kind.${pasted.kind}`) }]
    : rows.map((r) => ({ id: r.id, title: r.title, meta: r.meta }));
  let status: string | undefined;
  if (error) status = REASONS.includes(error.code) ? t(`issues.reason.${error.code}`) : t(`error.${error.code}`);
  else if (loading) status = t("workspace.details.linkedLoading");
  else if (!pasted && query.trim() !== "" && query === draft && rows.length === 0) status = t("workspace.details.linkedNone");

  return (
    <SearchPicker
      label={t("workspace.details.linkedSearch")}
      placeholder={t("workspace.details.linkedPlaceholder")}
      value={draft}
      onValueChange={setDraft}
      items={items}
      status={status}
      onPick={(id) => {
        if (pasted && pasted.url === id) return onPick(pasted, null);
        const row = rows.find((r) => r.id === id);
        if (row) onPick(row.item, row.source);
      }}
    />
  );
}
