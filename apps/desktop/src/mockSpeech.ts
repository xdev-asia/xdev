// The speech commands in memory for the browser demo: two canned microphones, access granted,
// and "dictated text" after each stop. No audio and no network.

import type { Api, ApiError, ErrorCode, MicDevice, SpeechLevel, SpeechSettings } from "./api";

type SpeechApi = Pick<
  Api,
  | "speechStart"
  | "speechStop"
  | "speechCancel"
  | "speechDevices"
  | "speechPermission"
  | "speechPermissionRequest"
  | "speechOpenPrivacy"
  | "speechSettingsGet"
  | "speechSettingsPut"
  | "onSpeechLevel"
>;

export type MockSpeech = SpeechApi & {
  /** Emits one `speech://level` event, as the capture thread would. */
  __speechLevel(e: SpeechLevel): void;
};

export const MOCK_SPEECH_TEXT = "dictated text";
export const MOCK_MICS: MicDevice[] = [
  { name: "Built-in Microphone", isDefault: true },
  { name: "USB Headset", isDefault: false },
];
const MODELS = ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"];
const DEFAULTS: SpeechSettings = { mode: "toggle", device: null, language: null, model: "gpt-4o-mini-transcribe" };

function reject(code: ErrorCode): Promise<never> {
  const error: ApiError = { code };
  return Promise.reject(error);
}

export function createMockSpeech(): MockSpeech {
  let settings: SpeechSettings = { ...DEFAULTS };
  let recording = false;
  const levels = new Set<(e: SpeechLevel) => void>();
  return {
    async speechStart() {
      if (recording) return reject("speech_busy");
      recording = true;
      const fallback = settings.device !== null && !MOCK_MICS.some((m) => m.name === settings.device);
      return { fallback };
    },
    async speechStop() {
      if (!recording) return reject("speech_not_recording");
      recording = false;
      return { text: MOCK_SPEECH_TEXT };
    },
    async speechCancel() {
      recording = false;
    },
    speechDevices: async () => MOCK_MICS.map((m) => ({ ...m })),
    speechPermission: async () => "granted",
    speechPermissionRequest: async () => "granted",
    speechOpenPrivacy: async () => {},
    speechSettingsGet: async () => ({ ...settings }),
    async speechSettingsPut(v) {
      const clean = (s: string | null) => (s?.trim() ? s.trim() : null);
      settings = {
        mode: v.mode,
        device: clean(v.device),
        language: clean(v.language),
        model: MODELS.includes(v.model.trim()) ? v.model.trim() : DEFAULTS.model,
      };
      return { ...settings };
    },
    onSpeechLevel: async (cb) => {
      levels.add(cb);
      return () => void levels.delete(cb);
    },
    __speechLevel(e) {
      for (const cb of [...levels]) cb(e);
    },
  };
}
