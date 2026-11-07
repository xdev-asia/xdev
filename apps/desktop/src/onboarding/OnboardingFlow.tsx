import { Button, Dialog } from "@xdev-asia/ui";
import { useEffect, useReducer, useRef, useState } from "react";
import type { JSX } from "react";
import type { Theme } from "@xdev/bindings";
import type { Api, ProfilesView } from "@/api";
import { BrandMark } from "@/components/BrandMark";
import { useI18n } from "@/i18n";
import { getThemePreference, setThemePreference } from "@/ui/theme";
import { allowNotifications, flowReducer, initialFlow, isFirstStep, isLastStep, saveAnswers, STEPS, type FlowState } from "./flowModel";
import type { Answers } from "./onboardingState";
import { AgentStep } from "./steps/AgentStep";
import { LanguageStep } from "./steps/LanguageStep";
import { LookStep } from "./steps/LookStep";
import { NotificationsStep } from "./steps/NotificationsStep";
import "@/styles/onboarding.css";

/** The steps list and the "Step n of m" line. */
export function Progress(props: { step: number }): JSX.Element {
  const { t } = useI18n();
  return (
    <nav className="onb-progress" aria-label={t("onboarding.progress")}>
      <p className="onb-count">{t("onboarding.stepOf", { step: props.step + 1, total: STEPS.length })}</p>
      <ol className="onb-steps">
        {STEPS.map((id, i) => (
          <li key={id} data-state={i < props.step ? "done" : i === props.step ? "current" : "todo"} aria-current={i === props.step ? "step" : undefined}>
            <span className="onb-step-label">{t(`onboarding.step.${id}`)}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The wizard's frame: progress, the step, and Back / Next / Finish with Skip beside them. Next, or Finish on the last step, is the one primary button. */
export function FlowView(props: { flow: FlowState; busy: boolean; failed: boolean; body: JSX.Element; onBack(): void; onNext(): void; onFinish(): void; onSkip(): void; onConfirmSkip(): void; onCancelSkip(): void }): JSX.Element {
  const { t } = useI18n();
  const { flow } = props;
  return (
    <main className="onb" aria-labelledby="onb-title">
      <div className="onb-card">
        <header className="onb-head">
          <BrandMark size={32} />
          <h1 id="onb-title" className="onb-title">
            {t(`onboarding.title.${STEPS[flow.step]}`)}
          </h1>
        </header>
        <Progress step={flow.step} />
        <section className="onb-body">{props.body}</section>
        {props.failed && (
          <p className="error-text" role="alert">
            {t("onboarding.saveFailed")}
          </p>
        )}
        <footer className="onb-actions">
          <Button type="button" variant="secondary" disabled={props.busy} onClick={props.onSkip}>
            {t("onboarding.skip")}
          </Button>
          <span className="onb-spacer" />
          <Button type="button" variant="secondary" disabled={props.busy || isFirstStep(flow)} onClick={props.onBack}>
            {t("onboarding.back")}
          </Button>
          {isLastStep(flow) ? (
            <Button variant="primary" type="button" disabled={props.busy} onClick={props.onFinish}>
              {t("onboarding.finish")}
            </Button>
          ) : (
            <Button variant="primary" type="button" disabled={props.busy} onClick={props.onNext}>
              {t("onboarding.next")}
            </Button>
          )}
        </footer>
      </div>
      {flow.asking && (
        <Dialog modal title={t("onboarding.skip.title")} confirmLabel={t("onboarding.skip.confirm")} cancelLabel={t("onboarding.skip.cancel")} onConfirm={props.onConfirmSkip} onCancel={props.onCancelSkip}>
          {t("onboarding.skip.body")}
        </Dialog>
      )}
    </main>
  );
}

/** The first-run wizard: default agent and shell, look, language, notifications. */
export function OnboardingFlow(props: { api: Api; answers?: Answers; onFinish(answers: Answers): void; onSkip(): void }): JSX.Element {
  const { api } = props;
  const { t, locale } = useI18n();
  const [flow, dispatch] = useReducer(flowReducer, props.answers, initialFlow);
  const [profiles, setProfiles] = useState<ProfilesView | null>(null);
  const [theme, setTheme] = useState<Theme>("system");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // The theme to go back to when the person skips after trying one.
  const startTheme = useRef(getThemePreference());

  useEffect(() => {
    let stale = false;
    api.profiles().then((v) => !stale && setProfiles(v), () => {});
    api.uiSettingsGet().then((ui) => !stale && setTheme(ui.theme), () => {});
    return () => {
      stale = true;
    };
  }, [api]);

  const answer = (a: Answers) => dispatch({ type: "answer", answers: a });
  const step = STEPS[flow.step];

  async function allow(): Promise<void> {
    setBusy(true);
    const result = await allowNotifications(api, t("onboarding.notifications.testTitle"), t("onboarding.notifications.testBody"));
    answer({ notifications: result });
    setBusy(false);
  }

  async function finish(): Promise<void> {
    setBusy(true);
    setFailed(false);
    try {
      await saveAnswers(api, flow.answers);
    } catch {
      setFailed(true);
      setBusy(false);
      return;
    }
    // Reaching Finish passes every step, so what the pickers showed counts as chosen.
    props.onFinish({ agent: profiles?.defaultAgent, shell: profiles?.defaultShell, theme, language: locale, ...flow.answers });
  }

  const body =
    step === "agent" ? (
      <AgentStep view={profiles} answers={flow.answers} onAnswer={answer} />
    ) : step === "look" ? (
      <LookStep
        theme={theme}
        answers={flow.answers}
        onAnswer={(a) => {
          answer(a);
          if (a.theme) setThemePreference(a.theme);
        }}
      />
    ) : step === "language" ? (
      <LanguageStep onAnswer={answer} />
    ) : (
      <NotificationsStep answers={flow.answers} busy={busy} onAllow={() => void allow()} />
    );

  return (
    <FlowView
      flow={flow}
      busy={busy}
      failed={failed}
      body={body}
      onBack={() => dispatch({ type: "back" })}
      onNext={() => dispatch({ type: "next" })}
      onFinish={() => void finish()}
      onSkip={() => dispatch({ type: "askSkip" })}
      onCancelSkip={() => dispatch({ type: "cancelSkip" })}
      onConfirmSkip={() => {
        setThemePreference(startTheme.current);
        props.onSkip();
      }}
    />
  );
}
