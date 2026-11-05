import type {
  Api,
  AiKeyProvider,
  Account,
  ActiveAccount,
  Quota,
  Routing,
  ApiError,
  Change,
  Seen,
  ChangeKind,
  Commit,
  DocEntry,
  DocLink,
  ExportPlan,
  Freshness,
  SearchHit,
  StaleDoc,
} from "./api";
import { extractTitle, parseFrontmatter } from "./doc/frontmatter";
import { createResolver, parseLinks } from "./doc/links";
import { estimateTokens, type ExportDoc, planExport } from "./mockExport";
import { createMockAgentSessions } from "./mockAgentSessions";
import { createMockQuickCommands } from "./mockQuickCommands";
import { createMockIssues } from "./mockIssues";
import { createMockKit, type MockKit } from "./mockKit";
import { createMockLayout } from "./mockLayout";
import { createMockAutomations, type MockAutomations } from "./mockAutomations";
import { createMockCli, type MockCli } from "./mockCli";
import { createMockOpenIn, type MockOpenIn } from "./mockOpenIn";
import { createMockTermLinks, type MockTermLinks } from "./mockTermLinks";
import { createMockProfiles, type MockProfiles } from "./mockProfiles";
import { createMockThemes, type MockThemes } from "./mockThemes";
import { createMockPower } from "./mockPower";
import { createMockPty, type MockPtyd } from "./mockPty";
import { createMockKeybindings, type MockKeybindings } from "./mockKeybindings";
import { createMockXdevId, type MockXdevId } from "./mockXdevId";
import { createMockPorts } from "./mockPorts";
import { createMockSettings, createSettingsHub } from "./mockSettings";
import { createMockShell, type MockShell } from "./mockShell";
import { createMockStatus, type MockStatus } from "./mockStatus";
import { createMockSquads } from "./mockSquads";
import { createMockTasks } from "./mockTasks";
import { createMockWorkspace, type MockWorkspaceSeed } from "./mockWorkspace";
import { mockHash, type MockFiles } from "./mockFiles";

export { EXPORT_MARKER } from "./mockExport";

const MAX_DOC_BYTES = 5 * 1024 * 1024;
// Simulates the watcher's debounce so the UI sees its own writes echoed back, as with Tauri.
const ECHO_DELAY_MS = 300;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;
const MAX_FRESHNESS_COMMITS = 20;
const DAY = 24 * 60 * 60;

type MockClipboardImage = string | Error | { code: string } | null;
let mockClipboardImage: MockClipboardImage = null;
/** Sets what the mock clipboard holds for `clipboardImageSave`: a saved path, an error (or `{ code }`) to reject with, or null (no image). */
export function setMockClipboardImage(value: MockClipboardImage): void {
  mockClipboardImage = value;
}

export const DEMO_ROOT = "/demo/xdev-handbook";
const COMMIT_ID = /^[0-9a-f]{4,64}$/;

export const DEMO_SEED: Record<string, string> = {
  "README.md": [
    "# xDev handbook",
    "",
    "Project knowledge for the xDev team. Start with the architecture notes,",
    "then read the [[decisions|decisions log]] before changing a crate boundary.",
    "",
    "- `docs/` holds the living docs; new here? Read [Getting started](docs/guides/getting-started.md).",
    "- `notes/` holds meeting notes in English and Vietnamese.",
    "",
  ].join("\n"),
  "docs/architecture/tai-lieu-kien-truc.md": [
    "---",
    "agents: true",
    "tags: [kiến-trúc, core]",
    "---",
    "# Tài liệu kiến trúc",
    "",
    "Hệ thống gồm ba lớp: vault đọc và ghi tệp Markdown, store giữ chỉ mục SQLite,",
    "core nối hai lớp này lại với nhau.",
    "",
    "## Nguyên tắc",
    "",
    "- Tệp trên ổ đĩa luôn là nguồn sự thật.",
    "- Chỉ mục có thể xoá và dựng lại bất cứ lúc nào.",
    "",
    "Các quyết định chi tiết nằm trong [[decisions]].",
    "",
  ].join("\n"),
  "docs/architecture/decisions.md": [
    "---",
    "agents: [claude]",
    "---",
    "# Architecture decisions",
    "",
    "## 001: SQLite FTS5 for search",
    "",
    "Search must work offline and ignore Vietnamese diacritics, so we use the",
    "unicode61 tokenizer with remove_diacritics.",
    "",
  ].join("\n"),
  "docs/guides/getting-started.md": [
    "---",
    "title: Getting started with xDev",
    "agents: true",
    "---",
    "# Getting started",
    "",
    "Install the toolchain, then run `pnpm install` and `pnpm --filter desktop dev`.",
    "Open any folder of Markdown files to try search.",
    "",
  ].join("\n"),
  "notes/2026/hop-giao-ban.md": [
    "# Họp giao ban tuần 44",
    "",
    "- Hoàn thành bản M0: mở thư mục, sửa tài liệu, tìm kiếm.",
    "- Việc tiếp theo: liên kết giữa các tài liệu và xuất cho AI agent.",
    "- Xem lại [[tai-lieu-kien-truc]] và [[lo-trinh]] trước buổi sau.",
    "",
  ].join("\n"),
  // Stale against DEMO_COMMITS: three later commits touched the store.
  "docs/architecture/store.md": [
    "---",
    "title: Store design",
    "type: arch",
    "covers: [crates/xdev-store/**]",
    "verified: 3f2a9c1",
    "---",
    "# Store design",
    "",
    "The store keeps the search index in SQLite with FTS5. It can be deleted",
    "and rebuilt from the Markdown files at any time.",
    "",
  ].join("\n"),
  "docs/architecture/vault.md": [
    "---",
    "type: arch",
    "covers:",
    "  - crates/xdev-vault/**",
    "---",
    "# Vault",
    "",
    "The vault reads and writes Markdown files and never leaves its folder.",
    "",
  ].join("\n"),
  "notes/scratch.md": "Quick notes without a heading.\n\nThe title falls back to the file name.\n",
  // Shows how a skipped file looks in the list.
  "notes/legacy-export.md": "# Legacy export\n\nBroken encoding: \uD800\n",
};

// What an AI agent might write into the demo vault while xDev is open.
export const DEMO_OUTSIDE_EDIT = [
  "# xDev handbook",
  "",
  "Project knowledge for the xDev team. Start with the architecture notes,",
  "then read the [[decisions|decisions log]] before changing a crate boundary.",
  "",
  "- `docs/` holds the living docs; new here? Read [Getting started](docs/guides/getting-started.md).",
  "- `notes/` holds meeting notes in English and Vietnamese.",
  "- `reviews/` holds approved design reviews.",
  "",
  "Every change is reviewed in the Changes tab before it counts.",
  "",
].join("\n");

// What an agent might propose over MCP; it waits in Changes like any other edit.
export const DEMO_AI_EDIT = {
  path: "docs/guides/getting-started.md",
  content: [
    "---",
    "title: Getting started with xDev",
    "agents: true",
    "---",
    "# Getting started",
    "",
    "Install the toolchain, then run `pnpm install` and `pnpm --filter desktop dev`.",
    "Open any folder of Markdown files to try search.",
    "",
    "To let an AI agent read these docs, run `xdev mcp` from the repo root.",
    "",
  ].join("\n"),
  note: "Mention xdev mcp for agents.",
};

// Code commits made after the docs were imported; `touched` are repo paths outside the vault's docs.
export type SeedCommit = { id: string; author: string; ago: number; message: string; touched: string[] };

export const DEMO_COMMITS: SeedCommit[] = [
  {
    id: "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    author: "Linh",
    ago: 12 * DAY,
    message: "Store: add the links table",
    touched: ["crates/xdev-store/src/schema.rs"],
  },
  {
    id: "8c41d07a2e9f3b6c1d8e4a7f0b3c6d9e2f5a8b1c",
    author: "Minh",
    ago: 5 * DAY,
    message: "Store: index the frontmatter type",
    touched: ["crates/xdev-store/src/index.rs"],
  },
  {
    id: "a17e3b2c9d4f6e8a0b1c3d5e7f9a2b4c6d8e0f13",
    author: "Linh",
    ago: 3 * DAY,
    message: "Vault: read covers and verified",
    touched: ["crates/xdev-vault/src/frontmatter.rs"],
  },
  {
    id: "5be90f4d1a3c5e7b9d2f4a6c8e0b2d4f6a8c0e25",
    author: "Minh",
    ago: DAY,
    message: "Store: record ai writes",
    touched: ["crates/xdev-store/src/ai_writes.rs", "crates/xdev-store/src/migrations.rs"],
  },
  {
    id: "d2096ce7f1b3d5a7c9e1f3b5d7a9c1e3f5b7d946",
    author: "Linh",
    ago: 2 * 60 * 60,
    message: "Store: busy timeout for the MCP server",
    touched: ["crates/xdev-store/src/lib.rs"],
  },
];

// api.ts imports this file, so its AI_KEY_PROVIDERS cannot be imported back without a cycle.
const AI_KEY_PROVIDERS: readonly AiKeyProvider[] = ["anthropic", "openai", "gemini"];

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

// Same rules as the Rust core; English on purpose, since history is shared with other people and tools.
export function defaultMessage(changes: Change[]): string {
  if (changes.length !== 1) return `Update ${changes.length} docs`;
  const [{ kind, path }] = changes;
  const verb: Record<ChangeKind, string> = { added: "Add", modified: "Update", deleted: "Delete" };
  return `${verb[kind]} ${path}`;
}

function newCommitId(): string {
  return [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// `touched` stands in for the commit's diff, which freshness matches `covers` against.
type MockCommit = Commit & { tree: Map<string, string>; touched: string[] };

function toCommit({ id, author, time, message }: MockCommit): Commit {
  return { id, author, time, message };
}

// A `covers` entry as a git `:(top,glob)` pathspec: `*` stays in a folder, `**` crosses folders,
// and a pattern that matches a folder takes in everything below it.
export function coverMatcher(entry: string): (path: string) => boolean {
  let source = "";
  for (let i = 0; i < entry.length; ) {
    if (entry.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
    } else if (entry.startsWith("**", i)) {
      source += ".*";
      i += 2;
    } else {
      const ch = entry[i++];
      source += ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const pattern = new RegExp(`^${source}$`);
  return (path) => {
    const parts = path.split("/");
    for (let n = parts.length; n > 0; n--) if (pattern.test(parts.slice(0, n).join("/"))) return true;
    return false;
  };
}

// Mirrors the Rust vault: no `..` segments and nothing absolute (POSIX, UNC or drive letter).
function isOutside(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path) || path.split(/[/\\]/).includes("..");
}

function skipReason(content: string): DocEntry["skipped"] {
  // A lone surrogate cannot be encoded as UTF-8, so it stands in for a non-UTF-8 file.
  if (/\p{Cs}/u.test(content)) return "not_utf8";
  if (new TextEncoder().encode(content).length > MAX_DOC_BYTES) return "too_large";
  return null;
}

type Folded = { text: string; origin: number[] };

// Folds case and diacritics while remembering where each folded char came from,
// so a match in the folded text can be highlighted in the original.
function fold(input: string): Folded {
  let text = "";
  const origin: number[] = [];
  let i = 0;
  for (const ch of input) {
    // NFD does not split đ into d + mark, but Vietnamese users type "d" for it.
    const folded = ch
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/đ/g, "d");
    for (const f of folded) {
      text += f;
      origin.push(i);
    }
    i += ch.length;
  }
  origin.push(i);
  return { text, origin };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Range = [number, number];

function findAll(source: Folded, original: string, terms: string[]): Range[] {
  const ranges: Range[] = [];
  for (const term of terms) {
    let at = source.text.indexOf(term);
    while (at !== -1) {
      const start = source.origin[at];
      // The end maps to the start of the next original char, covering any combining marks.
      const end = source.origin[at + term.length] ?? original.length;
      ranges.push([start, end]);
      at = source.text.indexOf(term, at + term.length);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

// Same contract as the store: escaped text with hits wrapped in <mark>, trimmed to a window.
function snippet(text: string, terms: string[]): string | null {
  const ranges = findAll(fold(text), text, terms);
  if (ranges.length === 0) return null;
  const [first, firstEnd] = ranges[0];
  let from = Math.max(0, first - SNIPPET_BEFORE);
  let to = Math.min(text.length, firstEnd + SNIPPET_AFTER);
  // Snap to word boundaries, never cutting into the first hit.
  const startSpace = text.indexOf(" ", from);
  if (from > 0 && startSpace !== -1 && startSpace < first) from = startSpace + 1;
  const endSpace = text.lastIndexOf(" ", to);
  if (to < text.length && endSpace > firstEnd) to = endSpace;
  let out = from > 0 ? "…" : "";
  let cursor = from;
  for (const [start, end] of ranges) {
    if (start < cursor || end > to) continue;
    out += escapeHtml(text.slice(cursor, start)) + "<mark>" + escapeHtml(text.slice(start, end)) + "</mark>";
    cursor = end;
  }
  out += escapeHtml(text.slice(cursor, to)) + (to < text.length ? "…" : "");
  return out.replace(/\s+/g, " ").trim();
}

export type MockApi = Api & MockPtyd & Omit<MockCli, keyof Api> & Omit<MockAutomations, keyof Api> & Pick<MockStatus, "__hook" | "__clickNotification" | "__notifications" | "__badge"> & Pick<MockKeybindings, "__editKeybindings" | "__reveals"> & Pick<MockXdevId, "__xdevIdExpire" | "__xdevIdDeepLink" | "__xdevIdManages" | "__xdevIdReopens"> & Pick<MockOpenIn, "__openInCalls"> & Pick<MockTermLinks, "__openedUrls" | "__defaultOpens"> & Pick<MockFiles, "__editFile" | "__fileReveals" | "__watchers" | "__overflow" | "__fileOpens" | "__failBytes"> & Pick<MockProfiles, "__installed" | "__docsOpened"> & Pick<MockThemes, "__paths"> & Pick<MockKit, "__shareLog"> & Pick<MockShell, "__menu" | "__quitMode" | "__attention" | "__opened" | "__labels" | "__windowCalls" | "__closeIntent"> & {
  // Changes a file the way another program would (`null` deletes it); xDev did not write it.
  __editOutside(path: string, content: string | null): void;
  // Writes a file the way `propose_update` does over MCP; throws an ApiError like the real tool.
  __propose(path: string, content: string, note: string | null): void;
};

type MockOptions = {
  repo?: boolean;
  // Files already at the export root (e.g. a hand-written CLAUDE.md), kept apart from the docs.
  exported?: Record<string, string>;
  // Committed after the imported docs, oldest first.
  commits?: SeedCommit[];
  // How long a fake task run takes.
  runDelayMs?: number;
  // Repos and pending changes for the workspace; the demo repo when left out.
  workspace?: MockWorkspaceSeed;
  // The text of `keybindings.json`; no file when left out.
  keybindings?: string | null;
  // The xDev ID account the mock starts with.
  xdevId?: "signedOut" | "signedIn";
  // A version the update check finds; nothing newer when left out.
  update?: string | null;
  // Providers that start with an API key saved.
  aiKeys?: AiKeyProvider[];
};

export function createMockApi(seed: Record<string, string>, options: MockOptions = {}): MockApi {
  const profiles = createMockProfiles();
  const accounts: Account[] = ["claude-2", "claude-3", "old"].map((name): Account => ({
    name, provider: "claude", dir: `/demo/accounts/${name}`,
    status: { state: name === "old" ? "logged_out" : "logged_in", email: name === "old" ? null : `${name}@example.com`, plan: name === "old" ? null : "Max", org: null },
  }));
  accounts.push({ name: "codex-1", provider: "codex", dir: "/demo/accounts/codex-1", status: { state: "logged_in", email: null, plan: null, org: null } });
  // One Claude account is active; Codex runs on the CLI's own home.
  let active: ActiveAccount[] = [{ provider: "claude", name: "claude-2" }];
  const accountListeners = new Set<() => void>();
  const accountsChanged = () => {
    for (const cb of [...accountListeners]) cb();
  };
  // The mock keeps the keys here and never returns them, like the real command.
  const aiKeys = new Map<AiKeyProvider, string>((options.aiKeys ?? []).map((p) => [p, "seeded"]));
  let routing: Routing = { rules: [{ role: "review", provider: "claude", maxPrompt: null, model: "haiku" }] };
  const reset = new Date(Date.now() + 130 * 60_000).toISOString();
  const asOf = new Date(Date.now() - 20 * 60_000).toISOString();
  const quotas: Quota[] = [
    { name: "claude-2", state: "ok", reason: null, windows: [{ key: "five_hour", utilization: 12, resetsAt: reset }, { key: "seven_day", utilization: 40, resetsAt: reset }], asOf: null },
    { name: "claude-3", state: "reserve", reason: null, windows: [{ key: "five_hour", utilization: 75, resetsAt: reset }], asOf: null },
    { name: "old", state: "unknown", reason: "logged_out", windows: [], asOf: null },
    { name: "codex-1", state: "ok", reason: null, windows: [{ key: "five_hour", utilization: 37, resetsAt: reset }, { key: "seven_day", utilization: 21, resetsAt: reset }], asOf },
  ];
  const files = new Map(Object.entries(seed));
  const exported = new Map(Object.entries(options.exported ?? {}));
  const listeners = new Set<(paths: string[]) => void>();
  let open = false;
  let last: string | null = null;
  let prompted = false;
  let repo = options.repo ?? true;
  let snapshotted = false;
  // Oldest first; the last one is HEAD.
  const commits: MockCommit[] = [];
  // Path → content of xDev's last write, which is what makes a pending change `app`.
  const written = new Map<string, string>();
  // Path → an agent's last proposal; a pending change is `ai` while the file still holds it.
  const proposed = new Map<string, { content: string; note: string | null }>();

  function notify(paths: string[]): void {
    setTimeout(() => listeners.forEach((cb) => cb(paths)), ECHO_DELAY_MS);
  }

  function headTree(): Map<string, string> {
    return commits.at(-1)?.tree ?? new Map();
  }

  function now(): number {
    return Math.floor(Date.now() / 1000);
  }

  function commit(tree: Map<string, string>, message: string, touched: string[], time = now()): string {
    const id = newCommitId();
    commits.push({ id, author: "You", time, message: message.split("\n")[0], tree, touched });
    return id;
  }

  function seedCommits(): void {
    const seeds = options.commits ?? [];
    // The import sits before the seeded code commits, so their times read in order.
    const oldest = Math.max(0, ...seeds.map((s) => s.ago));
    commit(new Map(files), "Import docs", [...files.keys()], now() - oldest - DAY);
    for (const { id, author, ago, message, touched } of seeds) {
      commits.push({ id, author, time: now() - ago, message, tree: headTree(), touched });
    }
  }

  function pending(): Change[] {
    const head = headTree();
    const paths = new Set([...files.keys(), ...head.keys()].filter((path) => path.endsWith(".md")));
    const changes: Change[] = [];
    for (const path of paths) {
      const disk = files.get(path);
      const then = head.get(path);
      if (disk === then) continue;
      const kind: ChangeKind = then === undefined ? "added" : disk === undefined ? "deleted" : "modified";
      const proposal = proposed.get(path);
      // The app's own write wins when an agent proposed the same text.
      const hash = disk === undefined ? null : mockHash(disk);
      if (kind !== "deleted" && written.get(path) === disk) changes.push({ path, kind, origin: "app", note: null, hash });
      else if (kind !== "deleted" && proposal !== undefined && proposal.content === disk)
        changes.push({ path, kind, origin: "ai", note: proposal.note, hash });
      else changes.push({ path, kind, origin: "outside", note: null, hash });
    }
    return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // Stale or crafted paths are ignored, and text edited since it was seen fails the call, as in the Rust core.
  function selected(seen: Seen[]): Change[] | "changed" {
    const picked: Change[] = [];
    for (const change of pending()) {
      const s = seen.find((x) => x.path === change.path);
      if (s === undefined) continue;
      if (s.hash !== change.hash) return "changed";
      picked.push(change);
    }
    return picked;
  }

  function vcsGuard(path?: string): ApiError["code"] | null {
    if (!open) return "no_vault";
    if (path !== undefined && isOutside(path)) return "outside_vault";
    if (!repo) return "no_repo";
    return null;
  }

  function findCommit(id: string): MockCommit | ApiError {
    if (!COMMIT_ID.test(id)) return { code: "git", detail: "bad_id" };
    return commits.find((c) => c.id.startsWith(id)) ?? { code: "git", detail: "unknown_commit" };
  }

  function entries(): DocEntry[] {
    return [...files.keys()]
      .filter((path) => path.endsWith(".md"))
      .sort()
      .map((path) => {
        const content = files.get(path)!;
        const skipped = skipReason(content);
        return {
          path,
          title: extractTitle(path, skipped ? "" : content),
          size: new TextEncoder().encode(content).length,
          skipped,
        };
      });
  }

  function guard(path: string): ApiError["code"] | null {
    if (!open) return "no_vault";
    if (isOutside(path)) return "outside_vault";
    return null;
  }

  function readable(): DocEntry[] {
    return entries().filter((doc) => doc.skipped === null);
  }

  async function plan(): Promise<ExportPlan> {
    const docs: ExportDoc[] = readable().map(({ path, title }) => {
      const { fm, body } = parseFrontmatter(files.get(path)!);
      return { source: path, title, targets: fm.agents, body };
    });
    const marked = docs.filter((doc) => doc.targets.length > 0);
    const planned = await planExport(marked, (path) => exported.get(path) ?? null);
    const agents = planned.find((file) => file.path === "AGENTS.md");
    return {
      root: last ?? "",
      files: planned,
      docs: marked.map(({ source, title, targets }) => ({ path: source, title, targets })),
      tokens: agents ? estimateTokens(agents.new) : 0,
    };
  }

  // Same rules as the core: commits after `verified` that touched a covered path.
  function freshness(content: string): Freshness {
    const { fm } = parseFrontmatter(content);
    const head = repo ? (commits.at(-1)?.id ?? null) : null;
    const base = { covers: fm.covers, verified: fm.verified, head, commits: [], count: 0 };
    if (fm.covers.length === 0) return { ...base, state: "none" };
    const verified = fm.verified;
    if (verified === null) return { ...base, state: "unverified" };
    const from = repo ? commits.findIndex((c) => c.id.startsWith(verified)) : -1;
    if (from === -1) return { ...base, state: "unknown" };
    const matchers = fm.covers.map(coverMatcher);
    const range = commits
      .slice(from + 1)
      .filter((c) => c.touched.some((path) => matchers.some((matches) => matches(path))))
      .reverse();
    return {
      ...base,
      state: range.length > 0 ? "stale" : "fresh",
      commits: range.slice(0, MAX_FRESHNESS_COMMITS).map(toCommit),
      count: range.length,
    };
  }

  const settingsHub = createSettingsHub();
  const settingsApi = createMockSettings(settingsHub);
  const themes = createMockThemes(undefined, settingsHub.emit);
  const power = createMockPower(settingsApi);
  const workspace = createMockWorkspace(options.workspace, settingsHub.emit);
  const api: MockApi = {
    ...createMockTasks({
      defaultRepo: repo ? DEMO_ROOT : null,
      accountNames: () => accounts.map((a) => a.name),
      runDelayMs: options.runDelayMs,
    }),
    ...createMockSquads({
      defaultRepo: repo ? DEMO_ROOT : null,
      accounts: () => accounts,
      runDelayMs: options.runDelayMs,
    }),
    ...profiles,
    ...createMockPty(
      profiles,
      (cwd) => workspace.__setupRun(cwd),
      (provider) => active.find((a) => a.provider === provider)?.name ?? null,
    ),
    ...createMockStatus(settingsHub.emit),
    ...power,
    ...createMockPorts(DEMO_ROOT),
    ...createMockShell(settingsHub.emit, options.update ?? null),
    ...workspace,
    ...createMockIssues(),
    ...settingsApi,
    ...themes,
    agentsSettingsPut: power.agentsSettingsPut,
    ...createMockKeybindings(options.keybindings ?? null),
    ...createMockXdevId(options.xdevId),
    ...createMockKit(async () => (await settingsApi.usageSettings()).scan),
    ...createMockOpenIn(settingsHub.emit, workspace.repoAdd),
    ...createMockTermLinks(workspace.filesList),
    ...createMockAgentSessions(settingsApi),
    ...createMockLayout(),
    ...createMockCli(),
    ...createMockAutomations(),
    ...createMockQuickCommands(
      {
        agentProfiles: async () => (await profiles.profiles()).profiles.map((p) => p.profile.id),
        repoPaths: async () => (await workspace.workspaceList()).map((r) => r.path),
      },
      settingsHub.emit,
    ),
    async clipboardImageSave() {
      if (mockClipboardImage === null || typeof mockClipboardImage === "string") return mockClipboardImage;
      throw mockClipboardImage;
    },
    async keyboardInputSource() { return "com.apple.keylayout.US"; },
    async accounts() { return structuredClone({ reservePercent: 30, accounts, active }); },
    async quota() { return structuredClone(quotas); },
    async updateStatus() { return null; },
    async onUpdateReady() { return () => {}; },
    async appVersion() { return "0.0.0-dev"; },
    async notifyUpdate() {},
    async addAccount(name, provider, dir) {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) return reject("bad_name");
      if (accounts.some(a => a.name === name)) return reject("exists");
      if (provider !== "claude" && provider !== "codex") return reject("unknown_provider");
      // An imported folder is the demo of a hive account that is already signed in.
      const account: Account = { name, provider, dir: dir ?? `/demo/accounts/${name}`, status: { state: dir ? "logged_in" : "logged_out", email: null, plan: null, org: null } };
      accounts.push(account);
      quotas.push({ name, state: "unknown", reason: "logged_out", windows: [], asOf: null });
      accountsChanged();
      return structuredClone(account);
    },
    async loginAccount(name) {
      const account = accounts.find(a => a.name === name);
      if (!account) return reject("not_found");
      const command = account.provider === "codex" ? `CODEX_HOME='${account.dir}' codex login` : `CLAUDE_CONFIG_DIR='${account.dir}' claude auth login`;
      return { opened: false, command };
    },
    async removeAccount(name) {
      const index = accounts.findIndex(a => a.name === name);
      if (index === -1) return reject("not_found");
      accounts.splice(index, 1);
      quotas.splice(quotas.findIndex(q => q.name === name), 1);
      active = active.filter((a) => a.name !== name);
      accountsChanged();
    },
    async accountActivate(provider, name) {
      if (name !== null && !accounts.some((a) => a.name === name && a.provider === provider)) return reject("not_found");
      active = active.filter((a) => a.provider !== provider);
      if (name !== null) active.push({ provider, name });
      accountsChanged();
    },
    async accountCarrySession(provider, from, to, session) {
      const known = (name: string | null) => name === null || accounts.some((a) => a.name === name && a.provider === provider);
      if (!known(from) || !known(to)) return reject("not_found");
      // The demo has no session logs on disk: any plain id is "copied".
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) return reject("session_missing");
      return from !== to;
    },
    async onAccountsChanged(cb) {
      accountListeners.add(cb);
      return () => void accountListeners.delete(cb);
    },
    async routing() { return structuredClone(routing); },
    async setRouting(next) {
      if (next.rules.some(r => !r.model.trim())) return reject("empty_text");
      routing = structuredClone(next);
    },
    async aiKeys() {
      return AI_KEY_PROVIDERS.map((provider) => ({ provider, saved: aiKeys.has(provider) }));
    },
    async aiKeySet(provider, key) {
      if (!AI_KEY_PROVIDERS.includes(provider)) return reject("unknown_provider");
      const trimmed = key.trim();
      if (!trimmed) return reject("empty_key");
      if ([...trimmed].length > 4096) return reject("too_large");
      aiKeys.set(provider, trimmed);
    },
    async aiKeyRemove(provider) {
      if (!AI_KEY_PROVIDERS.includes(provider)) return reject("unknown_provider");
      return aiKeys.delete(provider);
    },
    async models() {
      return { claude: ["fable", "opus", "sonnet"], codex: ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-luna"] };
    },
    async pickFile() {
      return themes.__paths()[0] ?? null;
    },
    async pickFolder() {
      return DEMO_ROOT;
    },
    async openVault(path) {
      open = true;
      last = path;
      prompted = true;
      if (repo && !snapshotted) seedCommits();
      snapshotted = true;
      return entries();
    },
    async lastVault() {
      return last;
    },
    async vaultSetup() {
      return { prompt: !prompted && last === null, defaultPath: "/demo/Documents/xDev" };
    },
    async dismissVaultPrompt() {
      prompted = true;
    },
    async createVault(_path, file, content) {
      if (!/^[^/\\]+\.md$/.test(file)) return reject("bad_path");
      // One in-memory folder: the starter only lands when it is empty, like a fresh folder on disk.
      if (files.size === 0) files.set(file, content);
    },
    async listDocs() {
      return open ? entries() : reject("no_vault");
    },
    async readDoc(path) {
      const bad = guard(path);
      if (bad) return reject(bad);
      const content = files.get(path);
      if (content === undefined) return reject("not_found");
      const skipped = skipReason(content);
      return skipped ? reject(skipped) : content;
    },
    async writeDoc(path, content) {
      const bad = guard(path);
      if (bad) return reject(bad);
      files.set(path, content);
      written.set(path, content);
      notify([path]);
    },
    async createDoc(path, content) {
      const bad = guard(path);
      if (bad) return reject(bad);
      if (files.has(path)) return reject("exists");
      files.set(path, content);
      written.set(path, content);
      notify([path]);
    },
    async cliPath() {
      return null;
    },
    async search(query, limit) {
      if (!open) return reject("no_vault");
      const terms = fold(query).text.split(/\s+/).filter(Boolean);
      if (terms.length === 0) return [];
      const hits: SearchHit[] = [];
      for (const doc of entries()) {
        if (doc.skipped) continue;
        const body = files.get(doc.path)!;
        const haystack = fold(`${doc.title}\n${body}`).text;
        if (!terms.every((term) => haystack.includes(term))) continue;
        const text = snippet(body, terms) ?? snippet(doc.title, terms) ?? escapeHtml(doc.title);
        hits.push({ path: doc.path, title: doc.title, snippet: text });
      }
      return hits.slice(0, limit);
    },
    async onVaultChanged(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    async vcsState() {
      if (!open) return reject("no_vault");
      return { status: repo ? "ok" : "no_repo" };
    },
    async initRepo() {
      if (!open) return reject("no_vault");
      repo = true;
    },
    async listChanges() {
      const bad = vcsGuard();
      return bad ? reject(bad) : pending();
    },
    async readBase(path) {
      const bad = vcsGuard(path);
      return bad ? reject(bad) : (headTree().get(path) ?? null);
    },
    async approve(seen, message) {
      const bad = vcsGuard();
      if (bad) return reject(bad);
      const chosen = selected(seen);
      if (chosen === "changed") return reject(chosen);
      if (chosen.length === 0) return null;
      const tree = new Map(headTree());
      for (const { path, kind } of chosen) {
        if (kind === "deleted") tree.delete(path);
        else tree.set(path, files.get(path)!);
        written.delete(path);
        proposed.delete(path);
      }
      const touched = chosen.map((c) => c.path);
      return commit(tree, message.trim() || defaultMessage(chosen), touched);
    },
    async reject(seen) {
      const bad = vcsGuard();
      if (bad) return reject(bad);
      const chosen = selected(seen);
      if (chosen === "changed") return reject(chosen);
      const head = headTree();
      for (const { path, kind } of chosen) {
        if (kind === "added") files.delete(path);
        else files.set(path, head.get(path)!);
        written.delete(path);
        proposed.delete(path);
      }
      if (chosen.length > 0) notify(chosen.map((c) => c.path));
    },
    async history(path, limit) {
      const bad = vcsGuard(path);
      if (bad) return reject(bad);
      // Like `git log -- path`: only commits whose version of the file differs from their parent's.
      const touched = commits.filter((c, i) => c.tree.get(path) !== commits[i - 1]?.tree.get(path));
      return touched.reverse().slice(0, limit).map(toCommit);
    },
    async readVersion(path, id) {
      const bad = vcsGuard(path);
      if (bad) return reject(bad);
      const found = findCommit(id);
      if ("code" in found) return reject(found.code, found.detail);
      return found.tree.get(path) ?? null;
    },
    async restoreVersion(path, id) {
      const content = await api.readVersion(path, id);
      if (content === null) return reject("not_found");
      await api.writeDoc(path, content);
    },
    async backlinks(path) {
      const bad = guard(path);
      if (bad) return reject(bad);
      const resolve = createResolver(entries().map((doc) => doc.path));
      const found: DocLink[] = [];
      for (const doc of readable()) {
        if (doc.path === path) continue;
        const links = parseLinks(files.get(doc.path)!);
        if (links.some((link) => resolve(link, doc.path) === path)) found.push({ path: doc.path, title: doc.title });
      }
      return found;
    },
    async exportPlan() {
      return open ? plan() : reject("no_vault");
    },
    async exportWrite(expected) {
      if (!open) return reject("no_vault");
      const writable = (await plan()).files.filter((file) => file.status === "new" || file.status === "changed");
      const key = (file: { path: string; hash: string }) => `${file.path}\n${file.hash}`;
      const want = expected.map(key).sort();
      const have = writable.map(key).sort();
      // What gets written must be exactly what the user previewed.
      if (want.length !== have.length || want.some((k, i) => k !== have[i])) return reject("stale");
      for (const file of writable) exported.set(file.path, file.new);
      return writable.map((file) => file.path);
    },
    async docFreshness(path) {
      const bad = guard(path);
      if (bad) return reject(bad);
      const content = files.get(path);
      if (content === undefined) return reject("not_found");
      const skipped = skipReason(content);
      return skipped ? reject(skipped) : freshness(content);
    },
    async staleDocs() {
      if (!open) return reject("no_vault");
      const found: StaleDoc[] = [];
      for (const { path, title } of readable()) {
        const { state, count } = freshness(files.get(path)!);
        if (state === "stale" || state === "unverified" || state === "unknown" || state === "unlinked") found.push({ path, title, state, count });
      }
      return found;
    },
    __editOutside(path, content) {
      if (content === null) files.delete(path);
      else files.set(path, content);
      notify([path]);
    },
    __propose(path, content, note) {
      const bad = vcsGuard(path);
      if (bad) throw { code: bad } satisfies ApiError;
      const disk = files.get(path);
      // Never over a person's pending edit: only over HEAD or the agent's own last proposal.
      if (disk !== headTree().get(path) && disk !== proposed.get(path)?.content) {
        throw { code: "conflict" } satisfies ApiError;
      }
      files.set(path, content);
      proposed.set(path, { content, note });
      notify([path]);
    },
  };
  // The spread above copied the values; these two stay live views of the profile store.
  Object.defineProperties(api, {
    __installed: { get: () => profiles.__installed, set: (ids: string[]) => void (profiles.__installed = ids), enumerable: true, configurable: true },
    __docsOpened: { get: () => profiles.__docsOpened, enumerable: true, configurable: true },
  });
  return api;
}
