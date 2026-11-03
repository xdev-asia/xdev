import { Button } from "@xdev/ui";
import type { JSX } from "react";
import type { Freshness } from "../api";
import { parseFrontmatter } from "../doc/frontmatter";
import { useI18n, type Locale } from "../i18n";
import { COMPACT } from "./ChangesPanel";

const SHORT_ID = 7;
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

// `time` and `now` are unix seconds; the largest whole unit reads best ("3 days ago", not "72 hours ago").
export function ago(locale: Locale, time: number, now: number): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diff = time - now;
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return format.format(Math.trunc(diff / size), unit);
  }
  return format.format(0, "second");
}

// Whether the button would change nothing: the draft already carries this HEAD and only needs saving.
export function verifiedInDraft(draft: string, head: string): boolean {
  const verified = parseFrontmatter(draft).fm.verified;
  return verified !== null && head.startsWith(verified);
}

export function WarnIcon(): JSX.Element {
  return (
    <svg
      className="banner-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </svg>
  );
}

export function FreshnessBanner(props: {
  freshness: Freshness;
  draft: string;
  // Unix seconds, passed in so the relative times stay testable.
  now: number;
  disabled: boolean;
  onMarkVerified(head: string): void;
}): JSX.Element | null {
  const { locale, t } = useI18n();
  const { state, covers, verified, head, commits, count } = props.freshness;
  if (state === "none" || state === "fresh") return null;
  const paths = covers.join(", ");
  const id = verified?.slice(0, SHORT_ID) ?? "";
  const body =
    state === "stale"
      ? t(count === 1 ? "freshness.stale.bodyOne" : "freshness.stale.body", { count, covers: paths, id })
      : state === "unverified"
        ? t("freshness.unverified.body", { covers: paths })
        : state === "unlinked"
          ? t("freshness.unlinked.body", { covers: paths })
          : head === null
            ? t("freshness.unknown.noGit", { covers: paths })
            : t("freshness.unknown.missing", { id });
  const pending = head !== null && verifiedInDraft(props.draft, head);
  return (
    <div className="banner banner-warn freshness-banner" data-state={state} role="status">
      <WarnIcon />
      <div className="banner-text">
        <strong>{t(`freshness.${state}.title`)}</strong>
        <span>{body}</span>
        {commits.length > 0 && (
          <ul className="freshness-commits" aria-label={t("freshness.commits")}>
            {commits.map((c) => (
              <li key={c.id} className="freshness-commit">
                <code className="history-id">{c.id.slice(0, SHORT_ID)}</code>
                <span className="freshness-subject">{c.message}</span>
                <span className="freshness-time">{ago(locale, c.time, props.now)}</span>
              </li>
            ))}
          </ul>
        )}
        {count > commits.length && (
          <span className="freshness-total">{t("freshness.total", { shown: commits.length, count })}</span>
        )}
        {pending && (
          <span className="freshness-pending">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 5 5L20 7" />
            </svg>
            {t("freshness.pending")}
          </span>
        )}
      </div>
      <div className="banner-actions">
        <Button
          type="button"
          className="freshness-verify"
          style={COMPACT}
          title={head === null ? t("freshness.noHead") : pending ? t("freshness.pending") : undefined}
          disabled={head === null || pending || props.disabled}
          onClick={() => head !== null && props.onMarkVerified(head)}
        >
          {t("freshness.verify")}
        </Button>
      </div>
    </div>
  );
}
