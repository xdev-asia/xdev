import { TERMINAL_SET_LIMITS as L } from "./terminalSets/limits";
import type { Api, ApiError, SequenceStep, StartupPreset, TerminalSet } from "./api";
import type { SettingsEmit } from "./mockSettings";

type TerminalSetsApi = Pick<
  Api,
  "terminalSetsList" | "terminalSetUpsert" | "terminalSetDelete" | "startupPresetsList" | "startupPresetUpsert" | "startupPresetDelete"
>;

function reject(detail: string): Promise<never> {
  const e: ApiError = { code: "bad_arg", detail };
  return Promise.reject(e);
}

const chars = (text: string) => [...text].length;

async function stepsChecked(steps: SequenceStep[]): Promise<SequenceStep[]> {
  if (steps.length > L.steps) return reject("steps");
  const out: SequenceStep[] = [];
  for (const step of steps) {
    const command = step.command.trimEnd();
    if (command.trim() === "" || chars(command) > L.command) return reject("command");
    if (step.wait.type === "seconds" && !(Number.isInteger(step.wait.seconds) && step.wait.seconds >= 1 && step.wait.seconds <= L.waitSeconds)) return reject("wait");
    out.push({ command, wait: step.wait });
  }
  return out;
}

function nameOf(raw: string): Promise<string> | string {
  const name = raw.trim();
  return name === "" || chars(name) > L.name ? reject("name") : name;
}

/** Adds `item`, or replaces the one with its id in place; a new one gets an id. */
function put<T extends { id: string }>(list: T[], item: T, make: () => string): { list: T[]; saved: T } | Promise<never> {
  const saved = { ...item, id: item.id === "" ? make() : item.id };
  const at = list.findIndex((x) => x.id === saved.id);
  if (at < 0 && list.length >= L.list) return reject("list");
  return { list: at >= 0 ? list.map((x, i) => (i === at ? saved : x)) : [...list, saved], saved };
}

/**
 * Terminal sets and startup presets in memory, checked and stored the way `terminal_sets.rs` does:
 * new ones go at the end, every change emits `terminalSets`.
 */
export function createMockTerminalSets(agentProfiles: () => Promise<string[]>, emit: SettingsEmit = () => {}): TerminalSetsApi {
  let sets: TerminalSet[] = [];
  let presets: StartupPreset[] = [];
  let next = 1;

  return {
    async terminalSetsList() {
      return structuredClone(sets);
    },
    async terminalSetUpsert(item) {
      const name = await nameOf(item.name);
      if (item.entries.length === 0 || item.entries.length > L.entries) return reject("entries");
      const known = await agentProfiles();
      const entries: TerminalSet["entries"] = [];
      for (const entry of item.entries) {
        let target = entry.target;
        if (target.type === "agent") {
          if (!known.includes(target.profile)) return reject("profile");
        } else {
          const command = target.command.trimEnd();
          if (chars(command) > L.command) return reject("command");
          target = { ...target, command };
        }
        let worktree = entry.worktree;
        if (worktree.type === "named") {
          const wanted = worktree.name.trim();
          if (wanted === "") return reject("worktree");
          worktree = { type: "named", name: wanted };
        }
        entries.push({ target, worktree, startup: await stepsChecked(entry.startup ?? []) });
      }
      const put_ = put(sets, { ...item, name, entries }, () => `ts-mock-${next++}`);
      if (put_ instanceof Promise) return put_;
      sets = put_.list;
      emit(["terminalSets"]);
      return structuredClone(put_.saved);
    },
    async terminalSetDelete(id) {
      if (!sets.some((s) => s.id === id)) return;
      sets = sets.filter((s) => s.id !== id);
      emit(["terminalSets"]);
    },
    async startupPresetsList() {
      return structuredClone(presets);
    },
    async startupPresetUpsert(item) {
      const name = await nameOf(item.name);
      if (item.steps.length === 0) return reject("steps");
      const steps = await stepsChecked(item.steps);
      const put_ = put(presets, { ...item, name, steps }, () => `sp-mock-${next++}`);
      if (put_ instanceof Promise) return put_;
      presets = put_.list;
      emit(["terminalSets"]);
      return structuredClone(put_.saved);
    },
    async startupPresetDelete(id) {
      if (!presets.some((p) => p.id === id)) return;
      presets = presets.filter((p) => p.id !== id);
      emit(["terminalSets"]);
    },
  };
}
