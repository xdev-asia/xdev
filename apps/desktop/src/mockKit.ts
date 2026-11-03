import type { Api, ApiError, Home, MemorySet, PromptEntry, Skill, UsageSummary } from "./api";
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
  | "kitPathsExist"
  | "kitPromptHistory"
>;

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
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HISTORY_MAX = 1000;
const DAY_MS = 86_400_000;

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
export function createMockKit(): KitApi {
  const knownTrees = new Set(DEMO_WORKSPACE.repos.flatMap((r) => r.worktrees.map((w) => w.path)));
  // Skill folders by path. Two skills share a name across the homes, so the demo has duplicates.
  const skills = new Map<string, SkillRow>([
    [`${CLAUDE_HOME}/skills/review`, { name: "review", description: "Review a diff before it is merged", homeId: "own-claude" }],
    [`${CLAUDE_HOME}/skills/release-notes`, { name: "release-notes", description: "Draft the notes for a release", homeId: "own-claude" }],
    [`${CODEX_HOME}/skills/review`, { name: "review", description: "Review a diff before it is merged", homeId: "own-codex" }],
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
    for (const r of rows) r.duplicate = rows.some((o) => o !== r && o.name === r.name);
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

  return {
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
      if (text === undefined) return reject("not_found", path);
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
      if (text === undefined) return reject("not_found", from);
      if (files.has(to)) return reject("changed");
      files.set(to, text);
    },
    async kitSkillCopy(dir, toSkillsDir, worktree) {
      const bad = checkTree(worktree);
      if (bad) return bad;
      const row = skills.get(dir);
      if (row === undefined) return reject("not_found", dir);
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
      if (!NAME.test(name)) return reject("bad_arg", name);
      const dir = `${target}/${name}`;
      if (skills.has(dir)) return reject("exists", dir);
      const home = HOMES.find((h) => target.startsWith(`${h.path}/`));
      skills.set(dir, { name, description, homeId: home?.id ?? "" });
      return `${dir}/SKILL.md`;
    },
    async kitSkillRemove(dir, worktree) {
      const bad = checkTree(worktree);
      if (bad) return bad;
      const row = skills.get(dir);
      if (row === undefined) return reject("not_found", dir);
      skills.delete(dir);
      moves += 1;
      const aside = `/demo/data/kit/removed/${moves}/${row.name}`;
      removed.set(aside, { dir, row });
      return aside;
    },
    async kitSkillRestore(aside, to, worktree) {
      const bad = checkTree(worktree);
      if (bad) return bad;
      // A folder already at the target wins, as in Rust: restoring never overwrites.
      if (skills.has(to)) return reject("changed");
      const gone = removed.get(aside);
      if (gone === undefined) return reject("not_found", aside);
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
}
