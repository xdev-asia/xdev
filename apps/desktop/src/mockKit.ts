import type { Agent, Api, Cost, ApiError, Home, MemorySet, ProviderSwitches, PromptEntry, Skill, UsageReport, UsageSummary } from "./api";
import { DEMO_WORKSPACE } from "./mockWorkspace";

type KitApi = Pick<
  Api,
  | "kitHomes"
  | "kitSkills"
  | "kitMemory"
  | "kitRead"
  | "kitWrite"
  | "kitCopy"
  | "kitSkillCopy"
  | "kitSkillNew"
  | "kitSkillRemove"
  | "kitSkillRestore"
  | "kitUsage"
  | "kitUsageReport"
  | "usageShareCopyImage"
  | "usageSharePost"
  | "kitPathsExist"
  | "kitPromptHistory"
>;

/** What the share commands received, for tests. */
export type ShareLog = { pngLength: number | null; post: string | null };
export type MockKit = KitApi & { __shareLog: ShareLog };

type MemoryFile = MemorySet["files"][number];
type Tokens = UsageSummary["days"][number][1];

const CLAUDE_HOME = "/demo/home/.claude";
const CODEX_HOME = "/demo/home/.codex";
const HOMES: Home[] = [
  { id: "own-claude", agent: "claude", path: CLAUDE_HOME, source: "own" },
  { id: "own-codex", agent: "codex", path: CODEX_HOME, source: "own" },
];
// What a demo repo holds on disk, for `kitPathsExist`.
const DEMO_REPO_FILES = ["README.md", "package.json", "src/App.tsx", "src/main.tsx", "docs/guide.md", "CLAUDE.md"];
// The name rule of `xdev_ai::valid_name`: 1 to 32 of a-z, 0-9 and "-", no leading "-".
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REMOVED_ROOT = "/demo/data/kit/removed";
const HISTORY_MAX = 1000;
const NO_COST: Cost = { nanos: 0, unpriced: false, priced: false };
const DAY_MS = 86_400_000;
// The earliest session of the demo's logs.
const TRACKING_SINCE = "2026-01-01T00:00:00Z";

const MEMORY_TEXT = [
  "# Working notes",
  "",
  "Read docs/missing.md before changing the build.",
  "Keep commits small.",
  "",
].join("\n");

const DEMO_HISTORY: PromptEntry[] = [
  { agent: "claude", text: "Explain the session store", at: Date.UTC(2026, 10, 3, 9, 30) },
  { agent: "codex", text: "Add a test for the status line", at: Date.UTC(2026, 10, 3, 8, 5) },
  { agent: "claude", text: "Rename the worktree helper", at: Date.UTC(2026, 10, 2, 16, 45) },
  { agent: "codex", text: "Why does the build warn about unused imports?", at: Date.UTC(2026, 10, 1, 11, 0) },
];

type SkillRow = { name: string; description: string; homeId: string };

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

// A short stand-in for the Rust content hash: it only has to tell two texts apart.
function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (const c of new TextEncoder().encode(text)) h = Math.imul(h ^ c, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

const sizeOf = (text: string) => new TextEncoder().encode(text).length;
const tokensOf = (bytes: number) => Math.ceil(bytes / 4);

function skillText(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`;
}

function addDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

// The same tokens for the same day, so a chart does not move between reloads.
function demoDay(day: string): Tokens {
  const n = Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
  const wave = 1 + (n % 5);
  return { input: 20_000 * wave, output: 6_000 * wave, cache_read: 90_000 * wave, cache_write: 12_000 * wave };
}

function scaled(t: Tokens, num: number, den: number): Tokens {
  const part = (v: number) => Math.floor((v * num) / den);
  return { input: part(t.input), output: part(t.output), cache_read: part(t.cache_read), cache_write: part(t.cache_write) };
}

function sum(list: Tokens[]): Tokens {
  const total: Tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  for (const t of list) {
    total.input += t.input;
    total.output += t.output;
    total.cache_read += t.cache_read;
    total.cache_write += t.cache_write;
  }
  return total;
}

const weight = (t: Tokens) => t.input + t.output + t.cache_read + t.cache_write;

/** In-memory agent kit that follows the Rust commands: the same error codes, stamps and roots. */
/** `scan` says which agents' logs may be read, like `usage.scan`; the default reads both. */
export function createMockKit(scan: () => Promise<ProviderSwitches> = async () => ({ claude: true, codex: true })): MockKit {
  const shareLog: ShareLog = { pngLength: null, post: null };
  const knownTrees = new Set(DEMO_WORKSPACE.repos.flatMap((r) => r.worktrees.map((w) => w.path)));
  // Skill folders by path. Two skills share a name across the homes, so the demo has duplicates.
  const skills = new Map<string, SkillRow>([
    [`${CLAUDE_HOME}/skills/review`, { name: "review", description: "Review a diff before it is merged", homeId: "own-claude" }],
    [`${CLAUDE_HOME}/skills/release-notes`, { name: "release-notes", description: "Draft the notes for a release", homeId: "own-claude" }],
    [`${CODEX_HOME}/skills/review`, { name: "review", description: "Review a diff, then list what to retest", homeId: "own-codex" }],
    [`${CODEX_HOME}/skills/triage`, { name: "triage", description: "Sort new issues by urgency", homeId: "own-codex" }],
  ]);
  const files = new Map<string, string>([
    [`${CLAUDE_HOME}/CLAUDE.md`, MEMORY_TEXT],
    [`${CODEX_HOME}/AGENTS.md`, "# Agent rules\n\nAnswer in short sentences.\n"],
  ]);
  const removed = new Map<string, { dir: string; row: SkillRow }>();
  const versions = new Map<string, number>();
  let moves = 0;

  const stampOf = (path: string, text: string) => `${hashOf(text)}-${versions.get(path) ?? 0}`;

  function checkTree(worktree: string | null): Promise<never> | null {
    return worktree !== null && !knownTrees.has(worktree) ? reject("outside", worktree) : null;
  }

  function inRoots(path: string, worktree: string | null): boolean {
    const roots = [...HOMES.map((h) => h.path), ...(worktree === null ? [] : [worktree])];
    return roots.some((r) => path.startsWith(`${r}/`));
  }

  function skillRows(): Skill[] {
    const rows = [...skills.entries()].map(([dir, s]) => {
      const bytes = sizeOf(skillText(s.name, s.description));
      return {
        name: s.name,
        description: s.description,
        scope: "user" as const,
        home_id: s.homeId,
        dir,
        bytes,
        tokens: tokensOf(bytes),
        hash: hashOf(skillText(s.name, s.description)),
        duplicate: false,
      };
    });
    // As in Rust: one name with different bytes. The same bytes in two homes are one skill.
    for (const r of rows) r.duplicate = rows.some((o) => o !== r && o.name === r.name && o.hash !== r.hash);
    return rows;
  }

  function memoryRows(worktree: string | null): MemoryFile[] {
    const entries = [...files.entries()].filter(([path]) => /\/(CLAUDE|AGENTS)\.md$/.test(path) && inRoots(path, worktree));
    return entries.map(([path, text]) => {
      const home = HOMES.find((h) => path.startsWith(`${h.path}/`));
      const bytes = sizeOf(text);
      const line = text.split("\n").findIndex((l) => l.includes("docs/missing.md"));
      return {
        path,
        home_id: home?.id ?? null,
        kind: "instructions" as const,
        parent: null,
        bytes,
        tokens: tokensOf(bytes),
        hash: hashOf(text),
        issues: line === -1 ? [] : [{ line: line + 1, kind: "missing_path" as const, target: "docs/missing.md" }],
        differs_in: [],
      };
    });
  }

  function newSkillDir(skillsDir: string): string | null {
    return HOMES.some((h) => skillsDir === `${h.path}/skills`) ? skillsDir : null;
  }

  const api: MockKit = {
    __shareLog: shareLog,
    async kitHomes() {
      return structuredClone(HOMES);
    },
    async kitSkills(worktree) {
      return checkTree(worktree) ?? skillRows();
    },
    async kitMemory(worktree) {
      const bad = checkTree(worktree);
      if (bad) return bad;
      const list = memoryRows(worktree);
      return { files: list, load_tokens: list.reduce((n, f) => n + f.tokens, 0) };
    },
    async kitRead(path, worktree) {
      const bad = checkTree(worktree);
      if (bad) return bad;
      const text = files.get(path);
      // A file that is not there is an I/O failure in Rust, not a code of its own.
      if (text === undefined) return reject("io", path);
      return { text, stamp: stampOf(path, text) };
    },
    async kitWrite(path, text, stamp, worktree) {
      const bad = checkTree(worktree);
      if (bad) return bad;
      if (!inRoots(path, worktree)) return reject("outside", path);
      const current = files.get(path);
      // A new file must be saved without a stamp; an old one with the stamp it was read with.
      if ((current === undefined ? null : stampOf(path, current)) !== stamp) return reject("changed");
      versions.set(path, (versions.get(path) ?? 0) + 1);
      files.set(path, text);
      return stampOf(path, text);
    },
    async kitCopy(from, to, worktree) {
      const bad = checkTree(worktree);
      if (bad) return bad;
      if (!inRoots(from, worktree)) return reject("outside", from);
      if (!inRoots(to, worktree)) return reject("outside", to);
      const text = files.get(from);
      if (text === undefined) return reject("io", from);
      if (files.has(to)) return reject("changed");
      files.set(to, text);
    },
    async kitSkillCopy(dir, toSkillsDir, worktree) {
      const bad = checkTree(worktree);
      if (bad) return bad;
      if (!inRoots(dir, worktree)) return reject("outside", dir);
      const row = skills.get(dir);
      if (row === undefined) return reject("kit_bad_input", "not a skill folder");
      const target = newSkillDir(toSkillsDir);
      if (target === null) return reject("outside", toSkillsDir);
      const made = `${target}/${row.name}`;
      if (skills.has(made)) return reject("changed");
      const home = HOMES.find((h) => target.startsWith(`${h.path}/`));
      skills.set(made, { ...row, homeId: home?.id ?? row.homeId });
      return made;
    },
    async kitSkillNew(skillsDir, name, description, worktree) {
      const bad = checkTree(worktree);
      if (bad) return bad;
      const target = newSkillDir(skillsDir);
      if (target === null) return reject("outside", skillsDir);
      if (!NAME.test(name)) return reject("bad_name", "bad skill name");
      if (description.includes("\n")) return reject("kit_bad_input", "the description is one line");
      const dir = `${target}/${name}`;
      // A name that is taken is a write with no stamp over a file, which Rust answers with `changed`.
      if (skills.has(dir)) return reject("changed");
      const home = HOMES.find((h) => target.startsWith(`${h.path}/`));
      skills.set(dir, { name, description, homeId: home?.id ?? "" });
      return `${dir}/SKILL.md`;
    },
    async kitSkillRemove(dir, worktree) {
      const bad = checkTree(worktree);
      if (bad) return bad;
      if (!inRoots(dir, worktree)) return reject("outside", dir);
      const row = skills.get(dir);
      if (row === undefined) return reject("kit_bad_input", "not a skill folder");
      skills.delete(dir);
      moves += 1;
      const aside = `${REMOVED_ROOT}/${moves}/${row.name}`;
      removed.set(aside, { dir, row });
      return aside;
    },
    async kitSkillRestore(aside, to, worktree) {
      const bad = checkTree(worktree);
      if (bad) return bad;
      // The order of Rust: the folder must be in the removed area and still there, then the
      // target must be inside the roots, and a folder already at the target wins (never overwritten).
      if (!aside.startsWith(`${REMOVED_ROOT}/`)) return reject("outside", aside);
      const gone = removed.get(aside);
      if (gone === undefined) return reject("kit_bad_input", "not a skill folder");
      if (!inRoots(to, worktree)) return reject("outside", to);
      if (skills.has(to)) return reject("changed");
      skills.set(to, gone.row);
      removed.delete(aside);
    },
    async kitUsage(sinceDay, untilDay, _refresh) {
      const days: Array<[string, Tokens]> = [];
      for (let d = sinceDay; d <= untilDay && days.length < 366; d = addDay(d, 1)) days.push([d, demoDay(d)]);
      const total = sum(days.map(([, t]) => t));
      // 70 % of the demo's tokens are Claude's, 30 % Codex's.
      const claude = scaled(total, 7, 10);
      const codex = scaled(total, 3, 10);
      const dayMap = (num: number) => Object.fromEntries(days.map(([d, t]) => [d, scaled(t, num, 10)]));
      const first = days.length === 0 ? 0 : Date.parse(`${days[0][0]}T00:00:00Z`);
      const last = days.length === 0 ? 0 : Date.parse(`${days[days.length - 1][0]}T23:59:59Z`);
      const folder = "/demo/xdev";
      return {
        days,
        by_home: [["own-claude", claude], ["own-codex", codex]].sort((a, b) => weight(b[1] as Tokens) - weight(a[1] as Tokens)) as UsageSummary["by_home"],
        by_folder: [[folder, total]],
        by_model: [["claude-sonnet-5-5", claude], ["gpt-5", codex]],
        top_sessions: [
          { id: "demo-session-1", home_id: "own-claude", agent: "claude", folder, model: "claude-sonnet-5-5", first, last, total: claude, days: dayMap(7) },
          { id: "demo-session-2", home_id: "own-codex", agent: "codex", folder, model: "gpt-5", first, last, total: codex, days: dayMap(3) },
        ],
      };
    },
    async kitUsageReport(args) {
      const off = await scan();
      const agents: Agent[] = (args.agent === null ? (["claude", "codex"] as Agent[]) : [args.agent]).filter((a) => off[a]);
      const empty = { days: [], by_home: [], by_folder: [], by_model: [], top_sessions: [] } satisfies UsageSummary;
      if (agents.length === 0) return { summary: empty, by_agent: [], sessions: 0, tracking_since: null, cost: NO_COST, cost_by_agent: [], recent_sessions: [], prices_as_of: "2026-11-04" };
      // All time reaches back a year in the demo; the first session is the same whatever the range.
      const since = args.sinceDay ?? addDay(args.untilDay, -365);
      const full = await api.kitUsage(since, args.untilDay, false);
      // The demo's tokens are 70 % Claude, 30 % Codex.
      const share: Record<Agent, number> = { claude: 7, codex: 3 };
      const num = agents.reduce((n, a) => n + share[a], 0);
      const homeAgent = (id: string): Agent => (id === "own-codex" ? "codex" : "claude");
      const days: UsageSummary["days"] = full.days.map(([d, t]) => [d, scaled(t, num, 10)]);
      const by_agent = agents
        .map((a) => [a, scaled(sum(full.days.map(([, t]) => t)), share[a], 10)] as [Agent, Tokens])
        .sort((a, b) => weight(b[1]) - weight(a[1]));
      const top_sessions = full.top_sessions.filter((s) => agents.includes(s.agent));
      const summary: UsageSummary = {
        days,
        by_home: full.by_home.filter(([id]) => agents.includes(homeAgent(id))),
        by_folder: [["/demo/xdev", sum(days.map(([, t]) => t))]],
        by_model: full.by_model.filter(([m]) => agents.includes(m === "gpt-5" ? "codex" : "claude")),
        top_sessions,
      };
      // Demo prices: 3 USD per million input and 15 per million output tokens, cache counted as input.
      const price = (t: Tokens): Cost => ({ nanos: (t.input + t.cache_read + t.cache_write) * 3000 + t.output * 15000, unpriced: false, priced: true });
      const cost_by_agent = by_agent.map(([a, t]) => [a, price(t)] as [Agent, Cost]);
      const cost = price(sum(by_agent.map(([, t]) => t)));
      return {
        summary, by_agent, sessions: top_sessions.length, tracking_since: Date.parse(TRACKING_SINCE),
        cost, cost_by_agent, recent_sessions: top_sessions, prices_as_of: "2026-11-04",
      } satisfies UsageReport;
    },
    async usageShareCopyImage(png) {
      shareLog.pngLength = png.length;
    },
    async usageSharePost(text) {
      shareLog.post = text;
    },
    async kitPathsExist(root, paths) {
      const home = HOMES.find((h) => h.path === root);
      if (!home && !knownTrees.has(root)) return reject("outside", root);
      const present = home
        ? new Set([...files.keys()].filter((p) => p.startsWith(`${root}/`)).map((p) => p.slice(root.length + 1)))
        : new Set(DEMO_REPO_FILES);
      return paths.map((p) => p !== "" && !p.startsWith("/") && !p.split("/").includes("..") && present.has(p));
    },
    async kitPromptHistory(limit) {
      return structuredClone([...DEMO_HISTORY].sort((a, b) => b.at - a.at).slice(0, Math.min(Math.max(limit, 0), HISTORY_MAX)));
    },
  };
  return api;
}
