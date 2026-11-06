// Owns dictation in the window: the `dictation.toggle` key, the keyup/Escape/blur listeners while
// recording, `speech://level`, and the pill at the bottom centre.

import { IconButton, Kbd, Spinner, StatusDot } from "@xdev-asia/ui";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { JSX } from "react";
import type { Api, SpeechMode } from "@/api";
import { useI18n } from "@/i18n";
import { chordLabel, useKeymap } from "@/keys/keymap";
import { useBindings } from "@/keys/bindingsStore";
import { pushToast } from "@/workspace/toastStore";
import { createDictation, isReleaseOf, type DictationToast, type Phase, type Trigger } from "./controller";
import { domInsertDeps, insertDictation, resolveTarget, type Target, type TargetElement } from "./insert";
import "@/styles/dictation.css";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** `m:ss` of a recording. */
export function elapsedLabel(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The pill; nothing while idle. */
export function DictationPill(props: {
  phase: Phase;
  elapsedMs: number;
  mode: SpeechMode;
  /** The bound chord as shown, or null when the action has none. */
  chord: string | null;
  t: T;
  onCancel(): void;
}): JSX.Element | null {
  const { phase, t } = props;
  if (phase === "idle") return null;
  if (phase === "transcribing") {
    return (
      <div className="dictation-pill" role="status" aria-live="polite">
        <Spinner label={t("dictation.transcribing")} />
        <span aria-hidden="true">{t("dictation.transcribing")}</span>
      </div>
    );
  }
  let hint: JSX.Element | null = null;
  if (props.mode === "hold") hint = <span className="dictation-hint">{t("dictation.hintHold")}</span>;
  else if (props.chord) {
    const [before, after = ""] = t("dictation.hintToggle", { key: "\u0000" }).split("\u0000");
    hint = (
      <span className="dictation-hint">
        {before}
        <Kbd>{props.chord}</Kbd>
        {after}
      </span>
    );
  }
  return (
    <div className="dictation-pill" role="status" aria-live="polite">
      <StatusDot tone="danger" label={<span>{t("dictation.recording")}</span>} />
      <span className="dictation-time">{elapsedLabel(props.elapsedMs)}</span>
      {hint}
      <IconButton icon="close" size="sm" label={t("dictation.cancel")} onClick={props.onCancel} />
    </div>
  );
}

const eventTrigger = (e: KeyboardEvent | undefined): Trigger | null =>
  e ? { code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey } : null;

export function DictationHost(props: {
  api: Api;
  /** Opens Settings at a section; the "Connect OpenAI" toast action goes to `voice`. */
  openSettings(section: string): void;
}): JSX.Element | null {
  const { api } = props;
  const openRef = useRef(props.openSettings);
  openRef.current = props.openSettings;
  const { t } = useI18n();
  const tRef = useRef<T>(t);
  tRef.current = t;
  useBindings();
  const mode = useRef<SpeechMode>("toggle");
  const trigger = useRef<Trigger | null>(null);

  const ctl = useRef(
    createDictation<Target>({
      api,
      now: () => performance.now(),
      mode: () => mode.current,
      target: () => resolveTarget(document.activeElement as unknown as TargetElement | null),
      insert: (target, text) => insertDictation(target, text, domInsertDeps),
      toast: (toast: DictationToast) => showToast(api, tRef.current, toast, (s) => openRef.current(s)),
    }),
  ).current;
  const state = useSyncExternalStore(ctl.subscribe, ctl.state, ctl.state);

  // The mode as stored; read again when Settings → Voice changes it.
  useEffect(() => {
    const load = () =>
      void api.speechSettingsGet().then(
        (s) => (mode.current = s.mode),
        () => {},
      );
    load();
    return api.onSettingsChanged((e) => {
      if (e.sections.includes("speech")) load();
    });
  }, [api]);

  useEffect(() => {
    const off = api.onSpeechLevel((e) => void ctl.level(e));
    return () => void off.then((stop) => stop());
  }, [api, ctl]);

  useKeymap({
    "dictation.toggle": (e) => {
      if (state.phase === "idle") trigger.current = eventTrigger(e);
      void ctl.press();
      return true;
    },
  });

  // While a session runs: Escape cancels, the release ends a hold, and a lost focus ends a hold.
  const active = state.phase === "starting" || state.phase === "recording";
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      void ctl.escape();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (mode.current !== "hold" || !trigger.current || !isReleaseOf(trigger.current, e)) return;
      e.preventDefault();
      e.stopPropagation();
      void ctl.release();
    };
    const onBlur = () => void ctl.blur();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [active, ctl]);

  return (
    <DictationPill
      phase={state.phase}
      elapsedMs={state.elapsedMs}
      mode={mode.current}
      chord={chordLabel("dictation.toggle")}
      t={t}
      onCancel={() => void ctl.escape()}
    />
  );
}

function showToast(api: Api, t: T, toast: DictationToast, openSettings: (section: string) => void): void {
  const actions =
    toast.action === "openPrivacy"
      ? [{ label: t("dictation.openPrivacy"), run: () => void api.speechOpenPrivacy().catch(() => {}) }]
      : toast.action === "connect"
        ? [{ label: t("dictation.connect"), run: () => openSettings("voice") }]
        : [];
  pushToast({ id: toast.key.startsWith("error.") ? "dictation-error" : undefined, text: t(toast.key, { detail: toast.detail ?? "" }), actions });
}
