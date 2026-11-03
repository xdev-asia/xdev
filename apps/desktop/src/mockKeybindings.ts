import type { Api } from "./api";

type KeybindingsApi = Pick<Api, "keybindingsRead" | "keybindingsWrite" | "keybindingsReveal" | "onKeybindingsChanged">;

export type MockKeybindings = KeybindingsApi & {
  // Changes the file the way an editor would (`null` deletes it); the change event fires.
  __editKeybindings(text: string | null): void;
  // How often `keybindingsReveal` ran.
  __reveals(): number;
};

export const MOCK_KEYBINDINGS_PATH = "/demo/config/keybindings.json";
const EMPTY_FILE = `${JSON.stringify({ version: 1, keybindings: {} }, null, 2)}\n`;
const MAX_BYTES = 1024 * 1024;

/** `keybindings.json` in memory; a write or an outside edit calls the change listeners synchronously. */
export function createMockKeybindings(initial: string | null = null): MockKeybindings {
  let text = initial;
  let reveals = 0;
  const listeners = new Set<(text: string | null) => void>();
  const emit = () => {
    for (const l of [...listeners]) l(text);
  };
  return {
    async keybindingsRead() {
      return { text, path: MOCK_KEYBINDINGS_PATH };
    },
    async keybindingsWrite(next) {
      if (new TextEncoder().encode(next).length > MAX_BYTES) throw { code: "bad_arg", detail: "keybindings.json is larger than 1 MiB" };
      text = next;
      emit();
    },
    async keybindingsReveal() {
      reveals += 1;
      if (text === null) {
        text = EMPTY_FILE;
        emit();
      }
    },
    async onKeybindingsChanged(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    __editKeybindings(next) {
      text = next;
      emit();
    },
    __reveals: () => reveals,
  };
}
