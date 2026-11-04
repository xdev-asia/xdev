import type { Api, ApiError, CustomShell, Profile, ProfilesView, ProfileView, ShellView } from "./api";

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
const RESERVED_SHELLS = ["powershell", "cmd", "login"];

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

const validId = (id: string) => ID.test(id) && id !== "shell";
const invalid = () => reject("invalid_profile");

export interface MockProfiles extends ProfilesApi {
  /** What the profile runs as now; `null` for an id the view does not list. */
  __permissions(id: string): string | null;
  /** The code `ptySpawn` fails with for `id`, or `null` when it may start. */
  __launchError(id: string): ApiError["code"] | null;
  /** The profile's own account; `null` when it has none or is not listed. */
  __account(id: string): string | null;
}

/**
 * An in-memory profile store: the three built-ins (Gemini not installed) and the demo shells.
 * Rules follow `crates/xdev-agent` `Profiles`; shell ids are unprefixed in the API and carry
 * `shell:` only in the view.
 */
export function createMockProfiles(): MockProfiles {
  let approvals: ProfilesView["approvals"] = "ask";
  let defaultAgent = "claude";
  // Stored without the prefix; unknown means the first shell on offer.
  let defaultShell: string | null = null;
  let profiles: Profile[] = [builtin("claude"), builtin("codex"), builtin("gemini")];
  let custom: CustomShell[] = [];

  const shellViews = (): ShellView[] => [
    ...DEMO_SHELLS,
    ...custom.map((s): ShellView => ({ id: `shell:${s.id}`, name: s.name, kind: "custom", custom: true })),
  ];
  const effective = (p: Profile): ProfileView["permissions"] => {
    if (p.cli === null) return "ask";
    return p.permissions ?? (follows(p) ? approvals : "ask");
  };
  const follows = (p: Profile) => p.cli !== null && p.permissions === null && p.args.length === 0 && p.env.length === 0;

  const viewOf = (profile: Profile): ProfileView => ({
    profile,
    builtin: profile.cli !== null,
    installed: profile.cli !== "gemini",
    path: profile.cli === "gemini" ? null : `/usr/bin/${profile.cli ?? profile.program ?? profile.id}`,
    permissions: effective(profile),
    followsApprovals: follows(profile),
    efforts: profile.cli ? BUILTIN_EFFORTS[profile.cli] : [],
  });
  const view = (): ProfilesView => {
    const shells = shellViews();
    const wanted = defaultShell === null ? null : `shell:${defaultShell}`;
    const chosen = shells.find((s) => s.id === wanted) ?? shells[0];
    return structuredClone({ approvals, defaultAgent, defaultShell: chosen.id, profiles: profiles.map(viewOf), shells });
  };

  return {
    async profiles() {
      return view();
    },
    async profilePut(input) {
      const p = structuredClone(input);
      if (!validId(p.id) || !p.name.trim()) return invalid();
      if (p.id in BUILTIN_NAMES) p.cli = p.id as Profile["cli"];
      else if (p.cli !== null) return invalid();
      // Only a CLI with an effort flag takes one.
      if (p.effort !== null && !(p.cli !== null && BUILTIN_EFFORTS[p.cli].includes(p.effort))) return invalid();
      if (p.program !== null ? !p.program.trim() : p.cli === null) return invalid();
      if (p.env.some((e) => e.name === "" || /[=\0]/.test(e.name) || e.value.includes("\0"))) return invalid();
      profiles = profiles.some((x) => x.id === p.id) ? profiles.map((x) => (x.id === p.id ? p : x)) : [...profiles, p];
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
      // A built-in loses its args, env and mode; model, effort, account and startup stay.
      if (found.cli !== null) found.args = [], found.env = [], found.permissions = null;
      return view();
    },
    async profilesDefaults(next, agent, shell) {
      if (!profiles.some((p) => p.id === agent)) return reject("unknown_profile");
      approvals = next;
      defaultAgent = agent;
      defaultShell = shell === null ? null : shell.replace(/^shell:/, "");
      return view();
    },
    async shellPut(s) {
      if (!validId(s.id) || RESERVED_SHELLS.includes(s.id) || !s.name.trim() || !s.program.trim()) return invalid();
      const copy = structuredClone(s);
      custom = custom.some((x) => x.id === s.id) ? custom.map((x) => (x.id === s.id ? copy : x)) : [...custom, copy];
      return view();
    },
    async shellRemove(id) {
      if (!custom.some((s) => s.id === id)) return reject("unknown_profile");
      custom = custom.filter((s) => s.id !== id);
      if (defaultShell === id) defaultShell = null;
      return view();
    },
    __permissions(id) {
      const found = profiles.find((p) => p.id === id);
      return found ? effective(found) : null;
    },
    __account(id) {
      return profiles.find((p) => p.id === id)?.account ?? null;
    },
    __launchError(id) {
      if (id === "shell") return null;
      if (id.startsWith("shell:")) return shellViews().some((s) => s.id === id) ? null : "unknown_profile";
      const found = profiles.find((p) => p.id === id);
      if (!found) return "unknown_profile";
      if (!found.enabled) return "profile_off";
      return viewOf(found).installed ? null : "not_installed";
    },
  };
}
