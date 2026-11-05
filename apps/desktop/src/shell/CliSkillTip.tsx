import { Button, Card } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type SkillStatus } from "@/api";
import { useI18n } from "@/i18n";
import { loadTipDismissed, markShown, saveTipDismissed, shownThisRun, tipVisible } from "./cliSkillTipModel";

const COPIED_MS = 2000;

async function writeClipboard(text: string): Promise<void> {
  await Promise.resolve(navigator.clipboard?.writeText(text)).catch(() => undefined);
}

export type TipPhase = "idle" | "installing" | "installed";

/** The card: what the skill does, one example, and the three ways to answer. */
export function CliSkillTipView(props: {
  phase: TipPhase;
  copied: boolean;
  /** An error code from the last install. */
  error?: string;
  onInstall(): void;
  onCopy(): void;
  onLater(): void;
  onDone(): void;
}): JSX.Element {
  const { t } = useI18n();
  const installing = props.phase === "installing";
  return (
    <aside className="cli-tip" role="complementary" aria-label={t("tip.cliSkill.label")}>
      <Card title={t("tip.cliSkill.title")}>
        <p className="cli-tip-eyebrow">{t("tip.eyebrow")}</p>
        <p className="cli-tip-text">{t("tip.cliSkill.body")}</p>
        <p className="cli-tip-text">{t("tip.cliSkill.try")}</p>
        <p className="ws-mono cli-tip-example">{t("tip.cliSkill.example")}</p>
        {props.error && (
          <p className="error-text" role="alert">
            {t(`error.${props.error}`)}
          </p>
        )}
        {props.phase === "installed" ? (
          <div className="settings-actions">
            <span className="settings-saved">{t("tip.cliSkill.installed")}</span>
            <Button type="button" onClick={props.onDone}>
              {t("tip.cliSkill.done")}
            </Button>
          </div>
        ) : (
          <div className="settings-actions settings-actions-start cli-tip-actions">
            <Button type="button" disabled={installing} aria-busy={installing} onClick={props.onInstall}>
              {installing ? t("tip.cliSkill.installing") : t("tip.cliSkill.install")}
            </Button>
            <Button type="button" variant="secondary" disabled={installing} onClick={props.onCopy}>
              {props.copied ? t("tip.cliSkill.copied") : t("tip.cliSkill.copy")}
            </Button>
            <Button type="button" variant="secondary" disabled={installing} onClick={props.onLater}>
              {t("tip.cliSkill.later")}
            </Button>
          </div>
        )}
      </Card>
    </aside>
  );
}

/** Offers the skill once per run, at the bottom right, while it is not installed. `suppressed` keeps it away (onboarding has the screen). */
export function CliSkillTip(props: { api: Pick<Api, "orchestrationSkillStatus" | "orchestrationSkillInstall">; suppressed?: boolean }): JSX.Element | null {
  const { api, suppressed = false } = props;
  const [status, setStatus] = useState<SkillStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<TipPhase>("idle");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A failed read leaves the status empty, so the tip stays hidden.
  useEffect(() => {
    let live = true;
    api.orchestrationSkillStatus().then(
      (s) => live && setStatus(s),
      () => undefined,
    );
    return () => {
      live = false;
      clearTimeout(copyTimer.current);
    };
  }, [api]);

  useEffect(() => {
    if (open || !tipVisible({ status, dismissed: loadTipDismissed(), shownThisRun: shownThisRun(), suppressed })) return;
    markShown();
    setOpen(true);
  }, [status, suppressed, open]);

  async function install(): Promise<void> {
    setPhase("installing");
    setError(undefined);
    try {
      setStatus(await api.orchestrationSkillInstall());
      setPhase("installed");
    } catch (e) {
      setError(toApiError(e).code);
      setPhase("idle");
    }
  }

  if (!open || status === null) return null;
  return (
    <CliSkillTipView
      phase={phase}
      copied={copied}
      error={error}
      onInstall={() => void install()}
      onCopy={() => {
        void writeClipboard(status.installCommand);
        setCopied(true);
        clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
      }}
      onLater={() => {
        saveTipDismissed();
        setOpen(false);
      }}
      onDone={() => setOpen(false)}
    />
  );
}
