import { QUICK_COMMAND_LIMITS } from "./quickCommands/limits";
import type { Api, ApiError, QuickCommand } from "./api";
import type { SettingsEmit } from "./mockSettings";

type QuickCommandsApi = Pick<
  Api,
  | "quickCommandsList"
  | "quickCommandUpsert"
  | "quickCommandDelete"
  | "quickCommandsMove"
  | "quickCommandUsed"
  | "quickCommandsRecent"
>;

/** What the store checks an upsert against: the agent profile ids and the workspace's repo paths. */
export type QuickCommandsLookup = {
  agentProfiles(): Promise<string[]>;
  repoPaths(): Promise<string[]>;
};

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  return Promise.reject(detail === undefined ? { code } : { code, detail });
}

const bytes = (text: string) => new TextEncoder().encode(text).length;
const chars = (text: string) => [...text].length;
const sameScope = (a: QuickCommand, b: QuickCommand) =>
  a.scope.type === b.scope.type && (a.scope.type === "global" || (b.scope.type === "repo" && a.scope.repo === b.scope.repo));

/**
 * Settings → Quick commands in memory, checked and stored the way `quick_commands.rs` does: new
 * commands go at the end of their scope, every change emits `quickCommands`.
 */
export function createMockQuickCommands(lookup: QuickCommandsLookup, emit: SettingsEmit = () => {}): QuickCommandsApi {
  let items: QuickCommand[] = [];
  let recent: string[] = [];
  let next = 1;

  async function checked(item: QuickCommand): Promise<QuickCommand> {
    const label = item.label.trim();
    if (label === "" || chars(label) > QUICK_COMMAND_LIMITS.label) return reject("bad_arg", "label");
    let scope = item.scope;
    if (scope.type === "repo") {
      const wanted = scope.repo;
      const repo = (await lookup.repoPaths()).find((p) => p === wanted);
      if (repo === undefined) return reject("bad_arg", "repo");
      scope = { type: "repo", repo };
    }
    let action = item.action;
    if (action.type === "terminal") {
      const command = action.command.trimEnd();
      if (command === "" || chars(command) > QUICK_COMMAND_LIMITS.command) return reject("bad_arg", "command");
      action = { ...action, command };
    } else {
      if (action.prompt.trim() === "" || bytes(action.prompt) > QUICK_COMMAND_LIMITS.promptBytes) return reject("bad_arg", "prompt");
      if (!(await lookup.agentProfiles()).includes(action.profile)) return reject("bad_arg", "profile");
    }
    return { id: item.id, label, scope, action };
  }

  return {
    async quickCommandsList() {
      return structuredClone(items);
    },
    async quickCommandUpsert(item) {
      const stored = await checked(item);
      const id = stored.id === "" ? `qc-mock-${next++}` : stored.id;
      const saved: QuickCommand = { ...stored, id };
      const at = items.findIndex((c) => c.id === id);
      const after = at >= 0 ? items.map((c, i) => (i === at ? saved : c)) : [...items, saved];
      const prompts = after.reduce((n, c) => n + (c.action.type === "agent" ? bytes(c.action.prompt) : 0), 0);
      if (prompts > QUICK_COMMAND_LIMITS.promptsTotalBytes) return reject("bad_arg", "prompts");
      items = after;
      emit(["quickCommands"]);
      return structuredClone(saved);
    },
    async quickCommandDelete(id) {
      if (!items.some((c) => c.id === id) && !recent.includes(id)) return;
      items = items.filter((c) => c.id !== id);
      recent = recent.filter((r) => r !== id);
      emit(["quickCommands"]);
    },
    async quickCommandsMove(id, to) {
      const item = items.find((c) => c.id === id);
      if (!item) return reject("not_found", id);
      const slots = items.flatMap((c, i) => (sameScope(c, item) ? [i] : []));
      const order = slots.map((i) => items[i]).filter((c) => c.id !== id);
      order.splice(Math.max(0, Math.min(to, order.length)), 0, item);
      const moved = [...items];
      slots.forEach((slot, k) => (moved[slot] = order[k]));
      items = moved;
      emit(["quickCommands"]);
    },
    async quickCommandUsed(id) {
      if (!items.some((c) => c.id === id)) return;
      recent = [id, ...recent.filter((r) => r !== id)].slice(0, QUICK_COMMAND_LIMITS.recent);
      emit(["quickCommands"]);
    },
    async quickCommandsRecent() {
      return [...recent];
    },
  };
}
