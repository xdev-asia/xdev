import { pickAgent } from "./workspace/agentPick";
import type { Api, ApiError, CustomShell, LaunchVerdict, Profile, ProfilesView, ProfileView, ShellView } from "./api";

type ProfilesApi = Pick<
  Api,
  | "profiles"
  | "profilePut"
  | "profileRemove"
  | "profileReset"
  | "profilesDefaults"
  | "agentsRefresh"
  | "agentDocsOpen"
  | "agentProbe"
  | "shellPut"
  | "shellRemove"
>;

type Cli = NonNullable<Profile["cli"]>;
type Mode = ProfileView["permissions"];

interface Spec {
  name: string;
  efforts: string[];
  models: string[];
  modes: Mode[];
  /** The first prompt is typed after the agent starts. */
  after: boolean;
  docs: string;
}

// Mirrors the table in `crates/xdev-agent/src/catalog.rs`, in `Cli::ALL` order.
const SPECS: Record<Cli, Spec> = {
  claude: { name: "Claude Code", efforts: ["low", "medium", "high", "xhigh", "max"], models: ["opus", "sonnet", "haiku"], modes: ["ask", "accept-edits", "auto", "skip"], after: false, docs: "https://code.claude.com/docs" },
  codex: { name: "Codex", efforts: ["low", "medium", "high"], models: [], modes: ["ask", "accept-edits", "auto", "skip"], after: false, docs: "https://github.com/openai/codex" },
  gemini: { name: "Gemini CLI", efforts: [], models: ["gemini-2.5-pro", "gemini-2.5-flash"], modes: ["ask", "accept-edits", "skip"], after: false, docs: "https://github.com/google-gemini/gemini-cli" },
  cursor: { name: "Cursor", efforts: [], models: [], modes: ["ask", "skip"], after: false, docs: "https://cursor.com/cli" },
  copilot: { name: "GitHub Copilot", efforts: [], models: [], modes: ["ask", "skip"], after: false, docs: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli" },
  opencode: { name: "OpenCode", efforts: [], models: [], modes: ["ask"], after: false, docs: "https://opencode.ai/docs/cli/" },
  amp: { name: "Amp", efforts: [], models: [], modes: ["ask", "skip"], after: true, docs: "https://ampcode.com/manual#install" },
  droid: { name: "Droid", efforts: [], models: [], modes: ["ask", "skip"], after: false, docs: "https://docs.factory.ai/cli/getting-started/quickstart" },
  "qwen-code": { name: "Qwen Code", efforts: [], models: [], modes: ["ask", "skip"], after: true, docs: "https://github.com/QwenLM/qwen-code" },
  kimi: { name: "Kimi", efforts: [], models: [], modes: ["ask", "skip"], after: true, docs: "https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html" },
  devin: { name: "Devin", efforts: [], models: [], modes: ["ask", "skip"], after: false, docs: "https://devin.ai/cli" },
  aider: { name: "Aider", efforts: [], models: [], modes: ["ask", "skip"], after: true, docs: "https://aider.chat/docs/" },
  goose: { name: "Goose", efforts: [], models: [], modes: ["ask", "skip"], after: true, docs: "https://goose-docs.ai/docs/quickstart/" },
  grok: { name: "Grok CLI", efforts: [], models: [], modes: ["ask"], after: true, docs: "https://github.com/superagent-ai/grok-cli" },
  kiro: { name: "Kiro CLI", efforts: [], models: [], modes: ["ask"], after: true, docs: "https://kiro.dev/cli/" },
  kilo: { name: "Kilo Code CLI", efforts: [], models: [], modes: ["ask"], after: true, docs: "https://kilo.ai/docs/cli" },
  cline: { name: "Cline CLI", efforts: [], models: [], modes: ["ask"], after: true, docs: "https://docs.cline.bot/cline-cli/overview" },
  antigravity: { name: "Antigravity", efforts: [], models: [], modes: ["ask"], after: true, docs: "https://antigravity.google/" },
  pi: { name: "Pi", efforts: [], models: [], modes: ["ask"], after: true, docs: "https://github.com/badlogic/pi-mono" },
  "command-code": { name: "Command Code", efforts: [], models: [], modes: ["ask"], after: true, docs: "https://commandcode.ai/docs" },
};
const CLIS = Object.keys(SPECS) as Cli[];
const isCli = (id: string): id is Cli => id in SPECS;
const ID = /^[a-z0-9-]{1,32}$/;
const RESERVED_SHELLS = ["powershell", "cmd", "login"];

// What each mode adds, as `ProfileView.modeFlags` reports it; a mode left out adds nothing.
const FLAGS: Record<Cli, Partial<Record<Mode, string[]>>> = {
  claude: { "accept-edits": ["--permission-mode", "acceptEdits"], auto: ["--permission-mode", "auto"], skip: ["--dangerously-skip-permissions"] },
  codex: {
    "accept-edits": ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
    auto: ["--approve-for-me"],
    skip: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  gemini: { "accept-edits": ["--approval-mode", "auto_edit"], skip: ["--approval-mode", "yolo"] },
  cursor: { skip: ["--yolo"] },
  copilot: { skip: ["--yolo"] },
  opencode: {},
  amp: { skip: ["--dangerously-allow-all"] },
  droid: { skip: ["--auto", "high"] },
  "qwen-code": { skip: ["--approval-mode", "yolo"] },
  kimi: { skip: ["--yolo"] },
  devin: { skip: ["--permission-mode", "bypass", "--respect-workspace-trust", "false"] },
  aider: { skip: ["--yes-always"] },
  goose: { skip: ["GOOSE_MODE=auto"] },
  grok: {},
  kiro: {},
  kilo: {},
  cline: {},
  antigravity: {},
  pi: {},
  "command-code": {},
};

/** The flag each mode's recipe starts with; an arg that holds one makes the profile custom. */
function heads(cli: Cli): string[] {
  return Object.values(FLAGS[cli]).flatMap((f) => (f[0]?.startsWith("-") ? [f[0]] : []));
}

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
/** Ids a profile cannot take: they are the default agent values; mirrors `RESERVED_PROFILES`. */
const RESERVED_PROFILES = ["auto", "blank"];
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
  /** What `agentProbe` says for an id; an installed agent is `ok` and a missing one `notInstalled` unless set here. */
  __verdicts: Record<string, LaunchVerdict>;
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
  const state = { installed: ["claude", "codex", "aider"], docsOpened: [] as string[], verdicts: {} as Record<string, LaunchVerdict> };
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
    models: profile.cli ? SPECS[profile.cli].models : [],
    customArgs: profile.cli !== null && profile.args.some((a) => heads(profile.cli!).some((h) => a === h || a.startsWith(`${h}=`))),
    modes: profile.cli ? SPECS[profile.cli].modes : [],
    modeFlags: profile.cli ? SPECS[profile.cli].modes.map((mode) => ({ mode, flags: FLAGS[profile.cli!][mode] ?? [] })) : [],
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
      if (!validId(p.id) || RESERVED_PROFILES.includes(p.id) || !p.name.trim()) return invalid();
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
    async agentProbe(id) {
      const found = profiles.find((p) => p.id === id);
      if (!found?.cli) return reject("unknown_profile");
      return state.verdicts[id] ?? (viewOf(found).installed ? { kind: "ok", version: "1.0.0" } : { kind: "notInstalled" });
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
    get __verdicts() {
      return state.verdicts;
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
