// The dictation state machine: idle → starting → recording → transcribing → idle. No DOM and no
// React; DictationHost feeds it keys, focus and level events, and draws its state.

import type { SpeechLevel, SpeechMode, SpeechStarted, SpeechText } from "@xdev/bindings";
import type { InsertResult } from "./insert";

/** Under this, a hold-mode release cancels: a tap, not speech. */
export const HOLD_MIN_MS = 300;

export type Phase = "idle" | "starting" | "recording" | "transcribing";

export interface DictationState {
  phase: Phase;
  /** From `speech://level`; 0 until the first event. */
  elapsedMs: number;
}

/** What a toast says: an i18n key, the error detail, and the action it offers. */
export interface DictationToast {
  key: string;
  detail?: string;
  action?: "openPrivacy" | "connect";
}

export interface DictationDeps<T> {
  api: {
    speechStart(): Promise<SpeechStarted>;
    speechStop(): Promise<SpeechText>;
    speechCancel(): Promise<void>;
  };
  now(): number;
  mode(): SpeechMode;
  /** Where the text will go, taken when dictation starts. */
  target(): T;
  insert(target: T, text: string): Promise<InsertResult>;
  toast(toast: DictationToast): void;
}

export interface Dictation {
  state(): DictationState;
  subscribe(fn: () => void): () => void;
  /** The dictation key went down. */
  press(): Promise<void>;
  /** The dictation key (or a modifier of its chord) came up; hold mode only. */
  release(): Promise<void>;
  /** The window lost the focus. */
  blur(): Promise<void>;
  /** True when Escape cancelled something and should be swallowed. */
  escape(): Promise<boolean>;
  level(event: SpeechLevel): Promise<void>;
}

/** The chord that started a hold: the key's `code` and its modifiers. */
export interface Trigger {
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** True when `up` releases `trigger`: its own key, or a modifier the chord holds. */
export function isReleaseOf(trigger: Trigger, up: { code: string }): boolean {
  if (up.code === trigger.code) return true;
  const modifier = /^(Meta|OS|Control|Alt|Shift)(Left|Right)?$/.exec(up.code)?.[1];
  switch (modifier) {
    case "Meta":
    case "OS":
      return trigger.meta;
    case "Control":
      return trigger.ctrl;
    case "Alt":
      return trigger.alt;
    case "Shift":
      return trigger.shift;
    default:
      return false;
  }
}

const ACTIONS: Partial<Record<string, DictationToast["action"]>> = {
  speech_mic_denied: "openPrivacy",
  speech_no_key: "connect",
};

function errorToast(e: unknown): DictationToast {
  const err = typeof e === "object" && e !== null ? (e as { code?: unknown; detail?: unknown }) : {};
  const code = typeof err.code === "string" ? err.code : "io";
  const detail = typeof err.detail === "string" ? err.detail : undefined;
  return { key: `error.${code}`, detail, action: ACTIONS[code] };
}

type After = "cancel" | { releasedAt: number } | null;

export function createDictation<T>(deps: DictationDeps<T>): Dictation {
  let state: DictationState = { phase: "idle", elapsedMs: 0 };
  const listeners = new Set<() => void>();
  let mode: SpeechMode = "toggle";
  let target: T | null = null;
  let startedAt = 0;
  // Each session's number; a late answer from an older one is ignored.
  let session = 0;
  // Set while starting: what to do once the start answers.
  let after: After = null;
  let capped = false;

  const set = (next: Partial<DictationState>) => {
    state = { ...state, ...next };
    for (const fn of [...listeners]) fn();
  };

  const cancel = async () => {
    session++;
    set({ phase: "idle", elapsedMs: 0 });
    await deps.api.speechCancel().catch(() => {});
  };

  const stop = async () => {
    const mine = session;
    const into = target;
    set({ phase: "transcribing" });
    try {
      const { text } = await deps.api.speechStop();
      if (mine !== session) return;
      if ((await deps.insert(into as T, text)) === "copied") deps.toast({ key: "dictation.copied" });
    } catch (e) {
      if (mine === session) deps.toast(errorToast(e));
    } finally {
      if (mine === session) set({ phase: "idle", elapsedMs: 0 });
    }
  };

  // A hold released at `at`: a tap cancels, a hold transcribes.
  const released = (at: number) => {
    if (at - startedAt < HOLD_MIN_MS) {
      deps.toast({ key: "dictation.holdHint" });
      return cancel();
    }
    return stop();
  };

  const start = async () => {
    const mine = ++session;
    mode = deps.mode();
    target = deps.target();
    startedAt = deps.now();
    after = null;
    capped = false;
    set({ phase: "starting", elapsedMs: 0 });
    let started: SpeechStarted;
    try {
      started = await deps.api.speechStart();
    } catch (e) {
      if (mine !== session) return;
      set({ phase: "idle" });
      deps.toast(errorToast(e));
      return;
    }
    if (mine !== session || after === "cancel") {
      // Escape came while the microphone opened.
      after = null;
      await deps.api.speechCancel().catch(() => {});
      return;
    }
    set({ phase: "recording" });
    if (started.fallback) deps.toast({ key: "dictation.fallbackMic" });
    // `after` may have changed while the start was pending; TypeScript cannot see that.
    const pending = after as After;
    after = null;
    if (pending && pending !== "cancel") await released(pending.releasedAt);
  };

  return {
    state: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    async press() {
      if (state.phase === "idle") return start();
      if (state.phase === "recording" && mode === "toggle") return stop();
    },
    async release() {
      if (mode !== "hold") return;
      if (state.phase === "starting") {
        if (after === null) after = { releasedAt: deps.now() };
        return;
      }
      if (state.phase === "recording") return released(deps.now());
    },
    async blur() {
      if (mode !== "hold") return;
      if (state.phase === "starting" && after === null) after = { releasedAt: Number.POSITIVE_INFINITY };
      if (state.phase === "recording") return stop();
    },
    async escape() {
      if (state.phase === "starting") {
        after = "cancel";
        session++;
        set({ phase: "idle", elapsedMs: 0 });
        return true;
      }
      if (state.phase !== "recording") return false;
      await cancel();
      return true;
    },
    async level(event) {
      if (state.phase !== "recording") return;
      set({ elapsedMs: event.elapsedMs });
      if (event.capped && !capped) {
        capped = true;
        await stop();
      }
    },
  };
}
