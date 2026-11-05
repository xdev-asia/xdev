import { CodeBlock, Tag } from "@xdev-asia/ui";
import type { JSX } from "react";
import { useI18n } from "@/i18n";

// The error codes this notice stands in for: a pull git would not reconcile by itself.
export const PULL_POLICY_CODES: ReadonlySet<string> = new Set(["pull_diverged", "pull_policy"]);

export const POLICY_COMMANDS = [
  { id: "merge", command: "git config pull.rebase false" },
  { id: "rebase", command: "git config pull.rebase true" },
  { id: "ffOnly", command: "git config pull.ff only" },
] as const;

/**
 * Shown in place of the inline error when a pull stopped for want of a policy. Three commands to
 * run once in the worktree, and a link to the setting that makes the app choose instead.
 */
export function PullPolicyNotice({ onOpenGitSettings }: { onOpenGitSettings?(): void }): JSX.Element {
  const { t } = useI18n();
  const labels = { copy: t("connect.copy"), copied: t("connect.copied") };
  return (
    <section className="ws-policy" role="alert" aria-label={t("ship.pullPolicy.title")}>
      <div className="ws-policy-head">
        <strong>{t("ship.pullPolicy.title")}</strong>
        <Tag tone="warn">{t("ship.pullPolicy.tag")}</Tag>
      </div>
      <p className="ws-policy-body">{t("ship.pullPolicy.body")}</p>
      {POLICY_COMMANDS.map(({ id, command }) => (
        <div key={id} className="ws-policy-row" data-policy={id}>
          <strong>{t(`ship.pullPolicy.${id}`)}</strong>
          <span className="ws-policy-hint">{t(`ship.pullPolicy.${id}.hint`)}</span>
          <CodeBlock code={command} labels={labels} />
        </div>
      ))}
      {onOpenGitSettings && (
        <button type="button" className="ws-ship-link" onClick={onOpenGitSettings}>
          {t("ship.pullPolicy.settings")}
        </button>
      )}
    </section>
  );
}
