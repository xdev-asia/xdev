import { Button, Field, IconButton, Select } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { Api, SequenceStep, StartupPreset } from "@/api";
import { toApiError } from "@/api";
import { useI18n } from "@/i18n";
import { TERMINAL_SET_LIMITS } from "./limits";
import { plainStep } from "./sequence";

type Kind = SequenceStep["wait"]["type"];

/** A step with its wait changed to `kind`; seconds keep what they had, else 5. */
export function withWaitKind(step: SequenceStep, kind: Kind): SequenceStep {
  if (kind === "seconds") return { ...step, wait: { type: "seconds", seconds: step.wait.type === "seconds" ? step.wait.seconds : 5 } };
  return { ...step, wait: { type: kind } };
}

/** True when every step has a command and its wait is in range: the form may be saved. */
export function stepsValid(steps: readonly SequenceStep[]): boolean {
  return (
    steps.length <= TERMINAL_SET_LIMITS.steps &&
    steps.every(
      (s) =>
        s.command.trim() !== "" &&
        s.command.length <= TERMINAL_SET_LIMITS.command &&
        (s.wait.type !== "seconds" || (Number.isInteger(s.wait.seconds) && s.wait.seconds >= 1 && s.wait.seconds <= TERMINAL_SET_LIMITS.waitSeconds)),
    )
  );
}

/**
 * The steps of a startup sequence: a command each, with what to wait for before the next. A preset
 * fills the list; "Save as preset" stores the list under a name. `onNote` hears a short status line.
 */
export function StepsEditor(props: {
  api?: Api;
  steps: SequenceStep[];
  presets: readonly StartupPreset[];
  onChange(steps: SequenceStep[]): void;
  onNote?(text: string): void;
}): JSX.Element {
  const { t } = useI18n();
  const { steps } = props;
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const patch = (i: number, next: SequenceStep) => props.onChange(steps.map((s, k) => (k === i ? next : s)));
  const waitOptions = [
    { value: "none", label: t("terminalSets.startup.wait.none") },
    { value: "seconds", label: t("terminalSets.startup.wait.seconds") },
    { value: "idle", label: t("terminalSets.startup.wait.idle") },
  ];

  async function savePreset() {
    if (!props.api) return;
    setError(null);
    try {
      const saved = await props.api.startupPresetUpsert({ id: "", name: name.trim(), steps });
      setName("");
      props.onNote?.(t("terminalSets.startup.presetSaved", { name: saved.name }));
    } catch (e) {
      setError(t(`error.${toApiError(e).code}`));
    }
  }

  return (
    <fieldset className="ts-steps">
      <legend>{t("terminalSets.startup.title")}</legend>
      <p className="ts-hint">{t("terminalSets.startup.hint")}</p>
      {props.presets.length > 0 && (
        <label className="ws-field">
          {t("terminalSets.startup.preset")}
          <Select
            options={[{ value: "", label: t("terminalSets.startup.preset.none") }, ...props.presets.map((p) => ({ value: p.id, label: p.name }))]}
            value=""
            onChange={(e) => {
              const p = props.presets.find((x) => x.id === e.target.value);
              if (p) props.onChange(structuredClone(p.steps));
            }}
          />
        </label>
      )}
      <ol className="ts-step-list">
        {steps.map((step, i) => (
          <li key={i} className="ts-step">
            <Field
              className="ws-mono"
              label={t("terminalSets.startup.command", { n: i + 1 })}
              value={step.command}
              spellCheck={false}
              onChange={(e) => patch(i, { ...step, command: e.target.value })}
            />
            <div className="ts-step-wait">
              <label className="ws-field">
                {t("terminalSets.startup.wait", { n: i + 1 })}
                <Select options={waitOptions} value={step.wait.type} onChange={(e) => patch(i, withWaitKind(step, e.target.value as Kind))} />
              </label>
              {step.wait.type === "seconds" && (
                <Field
                  label={t("terminalSets.startup.seconds", { n: i + 1 })}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={TERMINAL_SET_LIMITS.waitSeconds}
                  value={step.wait.seconds}
                  onChange={(e) => patch(i, { ...step, wait: { type: "seconds", seconds: Number.parseInt(e.target.value, 10) || 0 } })}
                />
              )}
              <IconButton icon="close" label={t("terminalSets.startup.remove", { n: i + 1 })} onClick={() => props.onChange(steps.filter((_, k) => k !== i))} />
            </div>
          </li>
        ))}
      </ol>
      <div className="ts-row">
        <Button
          variant="secondary"
          type="button"
          disabled={steps.length >= TERMINAL_SET_LIMITS.steps}
          onClick={() => props.onChange([...steps, plainStep("")])}
        >
          {t("terminalSets.startup.add")}
        </Button>
      </div>
      {props.api && steps.length > 0 && (
        <div className="ts-row">
          <Field
            label={t("terminalSets.startup.presetName")}
            value={name}
            maxLength={TERMINAL_SET_LIMITS.name}
            error={error ?? undefined}
            onChange={(e) => setName(e.target.value)}
          />
          <Button variant="secondary" type="button" disabled={name.trim() === "" || !stepsValid(steps)} onClick={() => void savePreset()}>
            {t("terminalSets.startup.savePreset")}
          </Button>
        </div>
      )}
    </fieldset>
  );
}
