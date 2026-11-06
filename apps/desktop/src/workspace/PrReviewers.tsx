import { SearchPicker, StatusDot, Tag, type SearchPickerItem } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type PrReviewer, type ReviewerState } from "@/api";
import { useI18n } from "@/i18n";

export const VERDICT_TONE: Record<ReviewerState, "ok" | "danger" | "neutral" | "warn"> = {
  approved: "ok",
  "changes-requested": "danger",
  commented: "neutral",
  dismissed: "neutral",
  requested: "warn",
};

// A GitHub login, or `org/team`; the backend refuses anything else with `bad_reviewer`.
const REVIEWER = /^(?!-)[A-Za-z0-9-]{1,39}(\/(?!-)[A-Za-z0-9_-]{1,100})?$/;
// Matches shown under the box at once.
const SHOWN = 8;

export function validReviewer(name: string): boolean {
  return REVIEWER.test(name);
}

/** The picker rows for `query`: matching collaborators not asked yet, then the query itself when it is a name. */
export function reviewerItems(query: string, candidates: readonly string[], taken: readonly string[]): SearchPickerItem[] {
  const q = query.trim();
  if (q === "") return [];
  const asked = new Set(taken.map((l) => l.toLowerCase()));
  const needle = q.toLowerCase();
  const found = candidates.filter((c) => !asked.has(c.toLowerCase()) && c.toLowerCase().includes(needle)).slice(0, SHOWN);
  const exact = found.some((c) => c.toLowerCase() === needle) || asked.has(needle);
  const items: SearchPickerItem[] = found.map((c) => ({ id: c, title: c }));
  if (!exact && validReviewer(q)) items.push({ id: q, title: q });
  return items;
}

/** The reviewers of a pull request as chips, each with its verdict as a status dot; open ones take a picker to ask more and a remove on each chip. */
export function PrReviewers(props: {
  api: Api;
  worktree: string;
  number: number;
  reviewers: PrReviewer[];
  /** Asks and removes; off for a merged or closed pull request. */
  editable: boolean;
  onChanged(): void | Promise<void>;
  onError(error: ApiError): void;
}): JSX.Element {
  const { api, worktree, number, reviewers, editable } = props;
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  // undefined while loading, null when the list is closed: free text still works.
  const [candidates, setCandidates] = useState<string[] | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const current = useRef(worktree);
  current.current = worktree;

  useEffect(() => {
    setQuery("");
    setCandidates(undefined);
    if (!editable) return;
    const at = worktree;
    api.worktreePrReviewerCandidates(at).then(
      (list) => current.current === at && setCandidates(list),
      () => current.current === at && setCandidates(null),
    );
  }, [api, worktree, editable]);

  async function edit(add: string[], remove: string[]): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await api.worktreePrReviewers(worktree, number, add, remove);
      setQuery("");
      await props.onChanged();
    } catch (e) {
      props.onError(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  const verdict = (state: ReviewerState): string => t(`prPanel.verdict.${state}`);
  const items = editable ? reviewerItems(query, candidates ?? [], reviewers.map((r) => r.login)) : [];
  const q = query.trim();
  const status = q === "" ? null : items.length === 0 && !validReviewer(q) ? t("error.bad_reviewer") : candidates === null ? t("prPanel.reviewers.noCandidates") : null;

  return (
    <div className="pr-reviewers">
      <h3 className="pr-h">{t("prPanel.reviewers")}</h3>
      {reviewers.length === 0 ? (
        <p className="ws-empty">{t("prPanel.noReviewers")}</p>
      ) : (
        <ul className="pr-chips">
          {reviewers.map((r) => (
            <li key={r.login} title={verdict(r.state)}>
              <Tag
                onRemove={editable ? () => void edit([], [r.login]) : undefined}
                removeLabel={editable ? t("prPanel.reviewers.remove", { login: r.login }) : undefined}
              >
                <StatusDot tone={VERDICT_TONE[r.state]} label={r.login} />
                <span className="x-sr-only">{verdict(r.state)}</span>
              </Tag>
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <SearchPicker
          label={t("prPanel.reviewers.add")}
          placeholder={t("prPanel.reviewers.addLabel")}
          value={query}
          onValueChange={setQuery}
          items={items}
          onPick={(id) => void edit([id], [])}
          status={status}
          labels={{ clear: t("prPanel.reviewers.clear") }}
        />
      )}
    </div>
  );
}
