import type { Api, ApiError, Profile, ProfilesView, ProfileView, ShellView } from "./api";

type ProfilesApi = Pick<
  Api,
  "profiles" | "profilePut" | "profileRemove" | "profileReset" | "profilesDefaults" | "shellPut" | "shellRemove"
>;

const BUILTIN_EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high"],
  gemini: [],
};
const BUILTIN_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };
const ID = /^[a-z0-9-]{1,32}$/;
const DEFAULT_SHELL = "shell:powershell";

function builtin(id: "claude" | "codex" | "gemini"): Profile {
  return {
    id, name: BUILTIN_NAMES[id], cli: id, program: null, args: [], env: [], model: null, effort: null,
    permissions: null, account: null, startup: [], enabled: true,
  };
}

const DEMO_SHELLS: ShellView[] = [
  { id: "shell:powershell", name: "PowerShell", kind: "powershell", custom: false },
  { id: "shell:cmd", name: "CMD", kind: "cmd", custom: false },
  { id: "shell:wsl:Ubuntu", name: "WSL Ubuntu", kind: "wsl", custom: false },
];

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  return Promise.reject(detail === undefined ? { code } : { code, detail });
}

export interface MockProfiles extends ProfilesApi {
  /** What the profile runs as now; `null` for an id the view does not list. */
  __permissions(id: string): string | null;
  /** True for an id `ptySpawn` may start: `shell`, a menu shell or a listed profile. */
  __knows(id: string): boolean;
}

/** An in-memory profile store: the three built-ins (Gemini not installed) and the demo shells. */
export function createMockProfiles(): MockProfiles {
  let approvals: ProfilesView["approvals"] = "ask";
  let defaultAgent = "claude";
  let defaultShell = DEFAULT_SHELL;
  let profiles: Profile[] = [builtin("claude"), builtin("codex"), builtin("gemini")];
  let shells: ShellView[] = structuredClone(DEMO_SHELLS);

  const viewOf = (profile: Profile): ProfileView => ({
    profile,
    builtin: profile.cli !== null,
    installed: profile.cli !== "gemini",
    path: profile.cli === "gemini" ? null : `/usr/bin/${profile.cli ?? profile.program ?? profile.id}`,
    permissions: profile.permissions ?? approvals,
    followsApprovals: profile.permissions === null,
    efforts: profile.cli ? BUILTIN_EFFORTS[profile.cli] : [],
  });
  const view = (): ProfilesView =>
    structuredClone({ approvals, defaultAgent, defaultShell, profiles: profiles.map(viewOf), shells });

  return {
    async profiles() {
      return view();
    },
    async profilePut(p) {
      if (!p.name.trim() || !ID.test(p.id) || p.id === "shell") return reject("invalid_profile");
      if (p.cli === null && !p.program?.trim()) return reject("invalid_profile");
      const copy = structuredClone(p);
      profiles = profiles.some((x) => x.id === p.id) ? profiles.map((x) => (x.id === p.id ? copy : x)) : [...profiles, copy];
      return view();
    },
    async profileRemove(id) {
      const found = profiles.find((p) => p.id === id);
      if (!found) return reject("unknown_profile");
      if (found.cli !== null) return reject("builtin_profile");
      profiles = profiles.filter((p) => p.id !== id);
      if (defaultAgent === id) defaultAgent = "claude";
      return view();
    },
    async profileReset(id) {
      const found = profiles.find((p) => p.id === id);
      if (!found) return reject("unknown_profile");
      const cli = found.cli;
      if (cli === null) return reject("invalid_profile");
      profiles = profiles.map((p) => (p.id === id ? builtin(cli) : p));
      return view();
    },
    async profilesDefaults(next, agent, shell) {
      const target = profiles.find((p) => p.id === agent);
      if (!target) return reject("unknown_profile");
      if (!target.enabled) return reject("profile_off");
      if (shell !== null && !shells.some((s) => s.id === shell)) return reject("unknown_profile");
      approvals = next;
      defaultAgent = agent;
      defaultShell = shell ?? DEFAULT_SHELL;
      return view();
    },
    async shellPut(s) {
      if (!s.name.trim() || !s.program.trim() || !s.id.startsWith("shell:") || s.id.length <= 6) return reject("invalid_profile");
      const old = shells.find((x) => x.id === s.id);
      if (old && !old.custom) return reject("builtin_profile");
      const entry: ShellView = { id: s.id, name: s.name, kind: "custom", custom: true };
      shells = old ? shells.map((x) => (x.id === s.id ? entry : x)) : [...shells, entry];
      return view();
    },
    async shellRemove(id) {
      const found = shells.find((s) => s.id === id);
      if (!found) return reject("unknown_profile");
      if (!found.custom) return reject("builtin_profile");
      shells = shells.filter((s) => s.id !== id);
      if (defaultShell === id) defaultShell = DEFAULT_SHELL;
      return view();
    },
    __permissions(id) {
      const found = profiles.find((p) => p.id === id);
      return found ? viewOf(found).permissions : null;
    },
    __knows(id) {
      return id === "shell" || shells.some((s) => s.id === id) || profiles.some((p) => p.id === id);
    },
  };
}
