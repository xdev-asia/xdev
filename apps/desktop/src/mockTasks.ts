import type { Api, ApiError, FileDiff, Task, TaskState } from "./api";

type TaskApi = Pick<
  Api,
  | "tasksContext"
  | "tasks"
  | "task"
  | "newTask"
  | "runTask"
  | "resumeTask"
  | "approveTask"
  | "discardTask"
  | "taskFileDiff"
>;

export type MockTaskOptions = {
  // Git root offered for a new task; null when the open folder has no repo.
  defaultRepo: string | null;
  accountNames(): string[];
  // How long a fake run takes, so the preview shows the running state.
  runDelayMs?: number;
};

export const DEMO_POLICY_PATH = "/demo/data/policy.json";

const HOUR = 60 * 60;
const BASE = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

const DEMO_DIFFS: Record<string, FileDiff | "binary"> = {
  "src/retry.ts": {
    old: "export async function fetchJson(url: string) {\n  const res = await fetch(url);\n  return res.json();\n}\n",
    new:
      "export async function fetchJson(url: string, tries = 3) {\n  for (let i = 1; ; i++) {\n    const res = await fetch(url);\n" +
      "    if (res.ok || i === tries) return res.json();\n  }\n}\n",
  },
  "src/retry.test.ts": {
    old: null,
    new: 'import { fetchJson } from "./retry";\n\nit("retries", async () => {\n  expect(fetchJson).toBeDefined();\n});\n',
  },
  "assets/logo.png": "binary",
};

function demoTasks(repo: string, data: string): Task[] {
  const t = now();
  const task = (id: string, goal: string, state: TaskState, ago: number): Task => ({
    id,
    goal,
    repo,
    base: BASE,
    branch: `xdev/task-${id}`,
    worktree: `${data}/worktrees/${id}`,
    state,
    runs: [],
    evidence: null,
    approval: null,
    created: t - ago,
  });
  const review = task("20261102-0900-retry-fetch", "Retry failed fetches up to three times\nKeep the public API.", "review", 2 * HOUR);
  review.runs = [
    { started: t - 2 * HOUR, ended: t - 2 * HOUR + 540, session_id: "demo-session-1", cost_usd: 0.4213, is_error: false, summary: "Added a retry loop and a test." },
  ];
  review.evidence = {
    base: BASE,
    head: HEAD,
    files: [
      { path: "assets/logo.png", added: null, removed: null },
      { path: "src/retry.test.ts", added: 5, removed: 0 },
      { path: "src/retry.ts", added: 4, removed: 1 },
    ],
    test: { command: ["pnpm", "test"], exit: 0, output_tail: " ✓ src/retry.test.ts (1 test)\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n" },
  };
  const failed = task("20261101-1500-docs-links", "Fix broken links in the docs", "failed", 20 * HOUR);
  failed.runs = [
    { started: t - 20 * HOUR, ended: t - 19 * HOUR, session_id: "demo-session-2", cost_usd: 1.07, is_error: true, summary: "agent timed out" },
  ];
  const merged = task("20261030-1000-readme", "Add a quick start to the README", "merged", 72 * HOUR);
  merged.runs = [{ started: t - 72 * HOUR, ended: t - 72 * HOUR + 300, session_id: "demo-session-3", cost_usd: 0.12, is_error: false, summary: "Done." }];
  merged.evidence = { base: BASE, head: HEAD, files: [{ path: "README.md", added: 12, removed: 0 }], test: null };
  merged.approval = { at: t - 70 * HOUR, merge_commit: "3333333333333333333333333333333333333333" };
  return [review, failed, merged];
}

// In-memory tasks that follow the agent crate's rules: the same states, the same gate for a test
// command (the default policy allows none, so any test asks), and the same error codes.
export function createMockTasks(options: MockTaskOptions): TaskApi {
  const data = "/demo/data";
  const tasks: Task[] = options.defaultRepo === null ? [] : demoTasks(options.defaultRepo, data);
  let seq = 0;

  function find(id: string): Task | undefined {
    return tasks.find((t) => t.id === id);
  }

  async function execute(task: Task, resume: string | null, account: string | null): Promise<Task> {
    if (account !== null && !options.accountNames().includes(account)) return reject("not_found");
    task.state = "running";
    const run = { started: now(), ended: null as number | null, session_id: resume, cost_usd: null as number | null, is_error: false, summary: "" };
    task.runs.push(run);
    await new Promise((resolve) => setTimeout(resolve, options.runDelayMs ?? 0));
    run.ended = now();
    run.session_id = resume ?? `demo-session-${task.id}`;
    run.cost_usd = 0.25;
    run.summary = "Made the change.";
    task.evidence = {
      base: task.base,
      head: HEAD,
      files: [{ path: "src/retry.ts", added: 4, removed: 1 }],
      test: null,
    };
    task.state = "review";
    return structuredClone(task);
  }

  return {
    async tasksContext() {
      return { defaultRepo: options.defaultRepo, policyPath: DEMO_POLICY_PATH };
    },
    async tasks() {
      return structuredClone([...tasks].sort((a, b) => (a.id < b.id ? 1 : -1)));
    },
    async task(id) {
      const task = find(id);
      return task ? structuredClone(task) : reject("not_found");
    },
    async newTask(repo, goal) {
      if (goal.trim() === "") return reject("empty_goal");
      if (repo.trim() === "") return reject("no_repo");
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
      const id = `${stamp}-${String(++seq).padStart(2, "0")}`;
      const task: Task = {
        id,
        goal: goal.trim(),
        repo,
        base: BASE,
        branch: `xdev/task-${id}`,
        worktree: `${data}/worktrees/${id}`,
        state: "ready",
        runs: [],
        evidence: null,
        approval: null,
        created: now(),
      };
      tasks.push(task);
      return structuredClone(task);
    },
    async runTask(id, account, test) {
      const task = find(id);
      if (!task) return reject("not_found");
      if (!["ready", "paused", "failed"].includes(task.state)) return reject("bad_state", task.state);
      const program = test?.trim().split(/\s+/)[0];
      if (program) return reject("needs_approval", `command requires approval: ${program}`);
      return execute(task, null, account);
    },
    async resumeTask(id, account) {
      const task = find(id);
      if (!task) return reject("not_found");
      if (!["paused", "failed"].includes(task.state)) return reject("bad_state", task.state);
      const session = [...task.runs].reverse().find((r) => r.session_id !== null)?.session_id;
      if (!session) return reject("no_session");
      return execute(task, session, account);
    },
    async approveTask(id) {
      const task = find(id);
      if (!task) return reject("not_found");
      if (task.state !== "review") return reject("bad_state", task.state);
      task.state = "merged";
      task.approval = { at: now(), merge_commit: "4444444444444444444444444444444444444444" };
      return structuredClone(task);
    },
    async discardTask(id) {
      const task = find(id);
      if (!task) return reject("not_found");
      if (["running", "merged", "discarded"].includes(task.state)) return reject("bad_state", task.state);
      task.state = "discarded";
      return structuredClone(task);
    },
    async taskFileDiff(id, path) {
      const task = find(id);
      if (!task) return reject("not_found");
      if (!task.evidence) return reject("bad_state", task.state);
      if (!task.evidence.files.some((f) => f.path === path)) return reject("not_found");
      const diff = DEMO_DIFFS[path] ?? { old: `// ${path}\n`, new: `// ${path}\n// changed\n` };
      return diff === "binary" ? reject("binary") : { ...diff };
    },
  };
}
