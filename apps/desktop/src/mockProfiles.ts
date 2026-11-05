import { pickAgent } from "./workspace/agentPick";
import type { Api, ApiError, CustomShell, Profile, ProfilesView, ProfileView, ShellView } from "./api";

type ProfilesApi = Pick<
  Api,
  | "profiles"
  | "profilePut"
  | "profileRemove"
  | "profileReset"
  | "profilesDefaults"
  | "agentsRefresh"
  | "agentDocsOpen"
  | "shellPut"
  | "shellRemove"
>;

type Cli = NonNullable<Profile["cli"]>;
type Mode = ProfileView["permissions"];

interface Spec {
  name: string;
  efforts: string[];
  modes: Mode[];
  /** The first prompt is typed after the agent starts. */
  after: boolean;
  /** The flag a permission recipe starts with, so an arg that holds one makes the profile custom. */
  heads: string[];
  docs: string;
}

// Mirrors the table in `crates/xdev-agent/src/catalog.rs`, in `Cli::ALL` order.
const SPECS: Record<Cli, Spec> = {
  claude: { name: "Claude Code", efforts: ["low", "medium", "high", "xhigh", "max"], modes: ["ask", "accept-edits", "auto", "skip"], after: false, heads: ["--permission-mode", "--dangerously-skip-permissions"], docs: "https://code.claude.com/docs" },
  codex: { name: "Codex", efforts: ["low", "medium", "high"], modes: ["ask", "accept-edits", "auto", "skip"], after: false, heads: ["--sandbox", "--ask-for-approval", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox"], docs: "https://github.com/openai/codex" },
  gemini: { name: "Gemini CLI", efforts: [], modes: ["ask", "accept-edits", "skip"], after: false, heads: ["--approval-mode"], docs: "https://github.com/google-gemini/gemini-cli" },
  cursor: { name: "Cursor", efforts: [], modes: ["ask", "skip"], after: false, heads: ["--yolo"], docs: "https://cursor.com/cli" },
  copilot: { name: "GitHub Copilot", efforts: [], modes: ["ask", "skip"], after: false, heads: ["--yolo"], docs: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli" },
  opencode: { name: "OpenCode", efforts: [], modes: ["ask"], after: false, heads: [], docs: "https://opencode.ai/docs/cli/" },
  amp: { name: "Amp", efforts: [], modes: ["ask", "skip"], after: true, heads: ["--dangerously-allow-all"], docs: "https://ampcode.com/manual#install" },
  droid: { name: "Droid", efforts: [], modes: ["ask", "skip"], after: false, heads: ["--auto"], docs: "https://docs.factory.ai/cli/getting-started/quickstart" },
  "qwen-code": { name: "Qwen Code", efforts: [], modes: ["ask", "skip"], after: true, heads: ["--approval-mode"], docs: "https://github.com/QwenLM/qwen-code" },
  kimi: { name: "Kimi", efforts: [], modes: ["ask", "skip"], after: true, heads: ["--yolo"], docs: "https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html" },
  devin: { name: "Devin", efforts: [], modes: ["ask", "skip"], after: false, heads: ["--permission-mode", "--respect-workspace-trust"], docs: "https://devin.ai/cli" },
  aider: { name: "Aider", efforts: [], modes: ["ask", "skip"], after: true, heads: ["--yes-always"], docs: "https://aider.chat/docs/" },
  goose: { name: "Goose", efforts: [], modes: ["ask", "skip"], after: true, heads: [], docs: "https://goose-docs.ai/docs/quickstart/" },
};
const CLIS = Object.keys(SPECS) as Cli[];
const isCli = (id: string): id is Cli => id in SPECS;
const ID = /^[a-z0-9-]{1,32}$/;
const RESERVED_SHELLS = ["powershell", "cmd", "login"];

function builtin(id: Cli): Profile {
  return {
    id, name: SPECS[id].name, cli: id, program: null, args: [], env: [], model: null, effort: null,
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
  /** Which built-in ids are installed; the next `agentsRefresh` (and any view) reads it. */
  __installed: string[];
  /** The ids `agentDocsOpen` was called with, in order. */
  __docsOpened: string[];
  /** Whether the agent's first prompt is typed after start rather than passed as an argument. */
  __promptAfter(id: string): boolean;
}

/**
 * An in-memory profile store: the 13 built-ins and the demo shells.
 * Installed: claude, codex, aider (`__installed`). Rules follow `crates/xdev-agent` `Profiles`; shell ids are unprefixed in the API and carry
 * `shell:` only in the view.
 */
export function createMockProfiles(): MockProfiles {
  let approvals: ProfilesView["approvals"] = "ask";
  // "auto", "blank" or a profile id, as `DefaultAgent` reads on the wire.
  let defaultAgent = "auto";
  // Stored without the prefix; unknown means the first shell on offer.
  let defaultShell: string | null = null;
  let profiles: Profile[] = CLIS.map(builtin);
  const state = { installed: ["claude", "codex", "aider"], docsOpened: [] as string[] };
  let custom: CustomShell[] = [];

  const shellViews = (): ShellView[] => [
    ...DEMO_SHELLS,
    ...custom.map((s): ShellView => ({ id: `shell:${s.id}`, name: s.name, kind: "custom", custom: true })),
  ];
  const effective = (p: Profile): ProfileView["permissions"] => {
    if (p.cli === null) return "ask";
    if (p.permissions !== null) return p.permissions;
    // A following profile takes the global mode only where its agent offers it.
    return follows(p) && SPECS[p.cli].modes.includes(approvals) ? approvals : "ask";
  };
  const follows = (p: Profile) => p.cli !== null && p.permissions === null && p.args.length === 0 && p.env.length === 0;

  const viewOf = (profile: Profile): ProfileView => ({
    profile,
    builtin: profile.cli !== null,
    installed: installed(profile),
    path: installed(profile) ? `/usr/bin/${profile.cli ?? profile.program ?? profile.id}` : null,
    permissions: effective(profile),
    followsApprovals: follows(profile),
    efforts: profile.cli ? SPECS[profile.cli].efforts : [],
    customArgs: profile.cli !== null && profile.args.some((a) => SPECS[profile.cli!].heads.some((h) => a === h || a.startsWith(`${h}=`))),
    modes: profile.cli ? SPECS[profile.cli].modes : [],
    docs: profile.cli !== null,
    promptAfter: profile.cli !== null && SPECS[profile.cli].after,
  });
  // Detection is a stub: a built-in is installed when listed, a custom program always is.
  const installed = (p: Profile) => (p.cli === null ? true : state.installed.includes(p.id));
  const view = (): ProfilesView => {
    const shells = shellViews();
    const wanted = defaultShell === null ? null : `shell:${defaultShell}`;
    const chosen = shells.find((s) => s.id === wanted) ?? shells[0];
    const resolvedDefault = pickAgent(defaultAgent, (id) => {
      const p = profiles.find((x) => x.id === id);
      return p !== undefined && p.enabled && installed(p);
    });
    return structuredClone({ approvals, defaultAgent, resolvedDefault, defaultShell: chosen.id, profiles: profiles.map(viewOf), shells });
  };

  return {
    async profiles() {
      return view();
    },
    async profilePut(input) {
      const p = structuredClone(input);
      if (!validId(p.id) || !p.name.trim()) return invalid();
      if (isCli(p.id)) p.cli = p.id;
      else if (p.cli !== null) return invalid();
      // Only a CLI with an effort flag takes one.
      if (p.effort !== null && !(p.cli !== null && SPECS[p.cli].efforts.includes(p.effort))) return invalid();
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
      if (defaultAgent === id) defaultAgent = "auto";
      return view();
    },
    async profileReset(id) {
      const found = profiles.find((p) => p.id === id);
      if (!found) return reject("unknown_profile");
      // A built-in loses its args, env and mode; model, effort, account and startup stay.
      if (found.cli !== null) found.args = [], found.env = [], found.permissions = null;
      return view();
    },
    async agentsRefresh() {
      return view();
    },
    async agentDocsOpen(id) {
      if (!isCli(id)) return reject("unknown_profile");
      state.docsOpened.push(id);
    },
    async profilesDefaults(next, agent, shell) {
      if (agent !== "auto" && agent !== "blank" && !profiles.some((p) => p.id === agent)) return reject("unknown_profile");
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
    get __installed() {
      return state.installed;
    },
    set __installed(ids) {
      state.installed = [...ids];
    },
    get __docsOpened() {
      return state.docsOpened;
    },
    __promptAfter(id) {
      const found = profiles.find((p) => p.id === id);
      return found?.cli ? SPECS[found.cli].after : false;
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
