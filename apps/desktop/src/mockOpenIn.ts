import type { Api, ApiError, OpenInApp, OpenInSettings, OpenTarget } from "./api";
import type { SettingsEmit } from "./mockSettings";

type OpenInApi = Pick<Api, "openInSettings" | "openInSettingsPut" | "openIn" | "repoClone" | "repoCloneCancel" | "repoCloneName">;

/** `OpenInSettings::default()` in Rust: VS Code alone. */
export const OPEN_IN_DEFAULTS: OpenInSettings = { apps: [{ id: "vscode", label: "VS Code", command: "code", args: [] }] };
/** The limits `open_in_settings_put` checks. */
export const OPEN_IN_LIMITS = { apps: 8, label: 40, command: 260, args: 8, arg: 200 } as const;

export type MockOpenIn = OpenInApi & {
  // Every `openIn` call, oldest first.
  __openInCalls(): { path: string; target: OpenTarget }[];
};

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const err: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(err);
}

function badApp(app: OpenInApp): string | null {
  const L = OPEN_IN_LIMITS;
  if (app.label.trim() === "" || app.label.length > L.label) return "label";
  if (app.command.trim() === "" || app.command.length > L.command) return "command";
  // A program name with spaces would be a shell line; an absolute path may have them.
  if (/\s/.test(app.command) && !/^([A-Za-z]:[\\/]|\/)/.test(app.command)) return "command";
  if (app.args.length > L.args || app.args.some((a) => a.length > L.arg)) return "args";
  return null;
}

/** The last path segment of a clone URL without `.git`: what `repo_clone_name` returns. */
export function cloneName(url: string): string | null {
  const last = url.trim().replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "";
  const name = last.replace(/\.git$/i, "");
  return name === "" || name === "." || name === ".." ? null : name;
}

/**
 * The Open In list in memory, `openIn` recorded instead of run, and a clone that sends two `phase`
 * events and then `done` with a repo added through `repoAdd`.
 */
export function createMockOpenIn(emit: SettingsEmit, repoAdd: Api["repoAdd"]): MockOpenIn {
  let settings: OpenInSettings = structuredClone(OPEN_IN_DEFAULTS);
  const calls: { path: string; target: OpenTarget }[] = [];
  const cancelled = new Set<string>();
  return {
    async openInSettings() {
      return structuredClone(settings);
    },
    async openInSettingsPut(v) {
      if (v.apps.length > OPEN_IN_LIMITS.apps) return reject("bad_arg", "apps");
      const ids = new Set(v.apps.map((a) => a.id));
      if (ids.size !== v.apps.length || v.apps.some((a) => a.id.trim() === "")) return reject("bad_arg", "id");
      for (const app of v.apps) {
        const field = badApp(app);
        if (field) return reject("bad_arg", field);
      }
      settings = structuredClone(v);
      emit(["openIn"]);
      return structuredClone(settings);
    },
    async openIn(path, target) {
      if (target.type === "app" && !settings.apps.some((a) => a.id === target.id)) return reject("not_found", target.id);
      calls.push({ path, target: structuredClone(target) });
    },
    async repoClone(url, parent, name, id, onEvent) {
      if (url.startsWith("-") || url.includes("\n") || /^(ext|fd)::/i.test(url)) return reject("bad_arg", url);
      const folder = name ?? cloneName(url);
      if (!folder) return reject("bad_arg", url);
      cancelled.delete(id);
      onEvent({ type: "phase", phase: "Receiving objects", percent: 50 });
      await Promise.resolve();
      if (cancelled.delete(id)) {
        onEvent({ type: "error", message: "cancelled" });
        return reject("cancelled");
      }
      onEvent({ type: "phase", phase: "Resolving deltas", percent: 100 });
      const repo = await repoAdd(`${parent.replace(/[\\/]+$/, "")}/${folder}`);
      onEvent({ type: "done", repo });
    },
    async repoCloneCancel(id) {
      cancelled.add(id);
    },
    async repoCloneName(url) {
      return cloneName(url) ?? reject("bad_arg", url);
    },
    __openInCalls() {
      return structuredClone(calls);
    },
  };
}
