import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { Button } from "@xdev-asia/ui";
import type { HelpLink } from "@/api";
import { useI18n } from "@/i18n";
import { useLicense, type License } from "@/license/useLicense";

const PLANS = ["pro", "sync", "team"];

/** The plan names the dialog shows: "Free" when there is none. */
export function planNames(plan: string[], t: (key: string) => string): string {
  const known = PLANS.filter((p) => plan.includes(p));
  return known.length === 0 ? t("about.plan.free") : known.map((p) => t(`about.plan.${p}`)).join(", ");
}

// Mounted only while open. `license` is for tests; the app reads the license itself.
export function AboutDialog(props: {
  version: string;
  /** `YYYY-MM-DD` of the build, when known. */
  buildDate?: string;
  license?: Pick<License, "state" | "plan">;
  onLink(link: HelpLink): void;
  onClose(): void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const own = useLicense();
  const { state, plan } = props.license ?? own;
  const updates = state?.state === "active" && state.pro?.updatesUntil != null ? state.pro.updatesUntil : null;
  const date = (secs: number) => new Date(secs * 1000).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="about-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <h2 id="about-title" className="dialog-title">
        {t("shell.help.about")}
      </h2>
      <p className="dialog-body">{t("shell.help.aboutVersion", { version: props.version })}</p>
      {props.buildDate && <p className="dialog-body">{t("about.buildDate", { date: props.buildDate })}</p>}
      <p className="dialog-body" data-field="about-plan">
        {t("about.plan", { plan: planNames(plan, t) })}
      </p>
      {updates !== null && (
        <p className="dialog-body" data-field="about-updates">
          {Date.now() / 1000 <= updates ? t("license.updatesUntil", { date: date(updates) }) : t("license.updatesEnded", { date: date(updates) })}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={() => props.onLink("docs")}>
          {t("shell.help.docs")}
        </button>
        <button type="button" className="btn-secondary" onClick={() => props.onLink("source")}>
          {t("shell.help.source")}
        </button>
        <Button type="button" autoFocus onClick={props.onClose}>
          {t("shell.help.close")}
        </Button>
      </div>
    </dialog>
  );
}
