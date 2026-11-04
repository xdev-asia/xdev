import type { JSX } from "react";
import type { Agent, UsageReport } from "@/api";
import { useI18n } from "@/i18n";
import { displayPath, formatCount, totalOf } from "@/kit/kitUi";
import { cacheReuse } from "@/kit/usageStats";

/** The newest sessions of one agent in the range: where, which model, when and how much (Claude: how much came from the cache). */
export function UsageRecentSessions(props: { agent: Agent; sessions: UsageReport["recent_sessions"] }): JSX.Element {
  const { t, locale } = useI18n();
  const { agent, sessions } = props;
  const title = t("usage.stats.recent.title");
  return (
    <section className="kit-block usage-recent" aria-label={title} data-recent={agent}>
      <h3 className="kit-h">{title}</h3>
      <p className="settings-hint" data-recent-desc>{t(`usage.stats.recent.desc.${agent}`)}</p>
      <div className="usage-scroll">
        <table className="kit-table">
          <thead>
            <tr>
              <th scope="col">{t("kit.usage.col.session")}</th>
              <th scope="col">{t("kit.usage.byFolder")}</th>
              <th scope="col">{t("kit.usage.byModel")}</th>
              <th scope="col">{t("kit.usage.col.last")}</th>
              {agent === "claude" ? (
                <th scope="col" className="kit-num">{t("usage.stats.cache.col")}</th>
              ) : (
                <th scope="col" className="kit-num">{t("kit.usage.total")}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const reuse = cacheReuse(s.total);
              return (
                <tr key={`${s.home_id}/${s.id}`} data-session={s.id}>
                  <td className="kit-cut" title={s.id}>{s.id.slice(0, 8)}</td>
                  <td className="kit-cut" title={s.folder === null ? "" : displayPath(s.folder)}>{s.folder === null ? t("kit.usage.noFolder") : displayPath(s.folder)}</td>
                  <td className="kit-cut">{s.model ?? t("usage.stats.recent.unknownModel")}</td>
                  <td>{s.last > 0 ? new Date(s.last).toLocaleString(locale) : "–"}</td>
                  {agent === "claude" ? (
                    <td className="kit-num" data-cache>{reuse === null ? "–" : `${Math.round(reuse * 100)}%`}</td>
                  ) : (
                    <td className="kit-num" data-total>{formatCount(totalOf(s.total), locale)}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
