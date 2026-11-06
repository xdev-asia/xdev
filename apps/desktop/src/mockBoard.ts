import type { Api, ApiError, BoardList, BoardTask, TaskPriority, TaskDraft, TaskFull, TaskLink, TaskPatch, TaskStatus } from "./api";

type BoardApi = Pick<
  Api,
  "boardList" | "boardGet" | "boardCreate" | "boardUpdate" | "boardDelete" | "boardCreateMany" | "boardLinks" | "boardLinkSet"
>;

export type MockBoard = BoardApi & {
  /** Changes a task as if its file was edited outside the app; `updated` moves. */
  __boardEditOutside(repo: string, id: string, patch: TaskPatch): void;
  /** The files of a repo's board as the Rust writer renders them. */
  __boardFiles(repo: string): { file: string; text: string }[];
};

const DIR = ".xdev/tasks";
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID = /^t[a-z2-7]{6}$/;
const TITLE_MAX = 300;

type Entry = { task: BoardTask; body: string };
type RepoBoard = { tasks: Map<string, Entry>; unreadable: { file: string; reason: string; text: string }[]; links: Map<string, TaskLink> };

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  return Promise.reject(detail === undefined ? { code } : { code, detail });
}

const oneLine = (s: string): string => s.split(/\s+/).filter(Boolean).join(" ");

function preview(body: string): string {
  return oneLine(body).slice(0, 200);
}

function withNewline(body: string): string {
  return body === "" || body.endsWith("\n") ? body : `${body}\n`;
}

function cleanLabels(labels: string[]): string[] {
  const out: string[] = [];
  for (const l of labels.map(oneLine)) if (l && !out.includes(l)) out.push(l);
  return out;
}

// Mirrors `needs_quote` in crates/xdev-board/src/frontmatter.rs.
function needsQuote(s: string): boolean {
  if (/:(\s|$)/.test(s)) return true;
  return /[#[\],"'\n\r\\]/.test(s) || /^\s|\s$/.test(s) || /^[->|&*!%@`?{}]/.test(s);
}

function scalar(s: string): string {
  if (!needsQuote(s)) return s;
  const body = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return `"${body}"`;
}

function render({ task: t, body }: Entry): string {
  const lines = [`id: ${scalar(t.id)}`, `title: ${scalar(t.title)}`, `status: ${t.status}`, `priority: ${t.priority}`];
  if (t.assignee) lines.push(`assignee: ${scalar(t.assignee)}`);
  lines.push(`labels: [${t.labels.map(scalar).join(", ")}]`, `created: ${scalar(t.created)}`, `updated: ${scalar(t.updated)}`);
  if (t.branch) lines.push(`branch: ${scalar(t.branch)}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function seedTasks(): Entry[] {
  const at = (n: number) => `2026-11-0${n}T09:00:00.000Z`;
  const make = (
    id: string,
    title: string,
    status: TaskStatus,
    priority: TaskPriority,
    labels: string[],
    n: number,
    body: string,
    extra: Partial<BoardTask> = {},
  ): Entry => ({
    task: { id, title, status, priority, assignee: null, labels, created: at(n), updated: at(n), branch: null, file: `${DIR}/${id}.md`, bodyPreview: preview(body), ...extra },
    body,
  });
  return [
    make("tbk2a3c", "Plan the offline sync", "backlog", "p3", ["docs"], 1, "Write down what has to work without a network.\n"),
    make("ttd4b5d", "Fix the login redirect loop", "todo", "p1", ["auth"], 2, "After sign in the page redirects back to sign in.\nDone when one sign in lands on the home page.\n", { assignee: "claude" }),
    make("tip6c7e", "Polish the settings page", "in-progress", "p2", ["ui"], 3, "Spacing and focus rings.\n", { branch: "polish-settings" }),
    make("trv2d3f", "Document the release steps", "in-review", "p2", ["docs", "ui"], 4, "Steps from tag to download page.\n"),
    make("tdn4e5g", "Rotate the signing key", "done", "p0", ["auth"], 5, "Done on the build machine.\n"),
  ];
}

function randomId(taken: (id: string) => boolean): string {
  for (;;) {
    let id = "t";
    for (let i = 0; i < 6; i++) id += ALPHABET[Math.floor(Math.random() * 32)];
    if (!taken(id)) return id;
  }
}

export function createMockBoard(): MockBoard {
  const empty = typeof location !== "undefined" && new URLSearchParams(location.search).get("board") === "empty";
  const repos = new Map<string, RepoBoard>();
  let lastStamp = "";

  // Strictly after the last one, so two saves in a row never share an `updated`.
  const stamp = (): string => {
    let t = Date.now();
    while (new Date(t).toISOString() <= lastStamp) t++;
    lastStamp = new Date(t).toISOString();
    return lastStamp;
  };

  const of = (repo: string): RepoBoard => {
    let b = repos.get(repo);
    if (!b) {
      b = { tasks: new Map(), unreadable: [], links: new Map() };
      if (!empty) {
        for (const e of seedTasks()) b.tasks.set(e.task.id, e);
        b.unreadable.push({ file: `${DIR}/broken.md`, reason: "the front matter has no closing ---", text: "---\ntitle: broken\nstatus: todo\n" });
      }
      repos.set(repo, b);
    }
    return b;
  };

  const entryOf = (repo: string, id: string): Entry | Promise<never> => {
    if (!ID.test(id)) return reject("board_bad_id");
    return of(repo).tasks.get(id) ?? reject("not_found");
  };

  const build = (id: string, d: TaskDraft, now: string): Entry | Promise<never> => {
    const title = oneLine(d.title);
    if (!title || title.length > TITLE_MAX) return reject("io", "the title is empty or too long");
    const body = withNewline(d.body ?? "");
    return {
      task: {
        id, title, status: d.status ?? "backlog", priority: d.priority ?? "p2", assignee: oneLine(d.assignee ?? "") || null,
        labels: cleanLabels(d.labels ?? []), created: now, updated: now, branch: null, file: `${DIR}/${id}.md`, bodyPreview: preview(body),
      },
      body,
    };
  };

  const apply = (e: Entry, p: TaskPatch, now: string): void => {
    const t = e.task;
    if (p.title !== undefined) t.title = oneLine(p.title);
    if (p.status !== undefined) t.status = p.status;
    if (p.priority !== undefined) t.priority = p.priority;
    if (p.assignee !== undefined) t.assignee = p.assignee === null ? null : oneLine(p.assignee) || null;
    if (p.labels !== undefined) t.labels = cleanLabels(p.labels);
    if (p.branch !== undefined) t.branch = p.branch === null ? null : oneLine(p.branch) || null;
    if (p.body !== undefined) {
      e.body = withNewline(p.body);
      t.bodyPreview = preview(e.body);
    }
    t.updated = now;
  };

  const copy = (t: BoardTask): BoardTask => ({ ...t, labels: [...t.labels] });

  return {
    async boardList(repo): Promise<BoardList> {
      const b = of(repo);
      const tasks = [...b.tasks.values()].map((e) => copy(e.task)).sort((a, c) => a.id.localeCompare(c.id));
      return { tasks, unreadable: b.unreadable.map(({ file, reason }) => ({ file, reason })) };
    },
    async boardGet(repo, id): Promise<TaskFull> {
      const e = await entryOf(repo, id);
      return { task: copy(e.task), body: e.body };
    },
    async boardCreate(repo, draft) {
      const b = of(repo);
      const e = await build(randomId((id) => b.tasks.has(id)), draft, stamp());
      b.tasks.set(e.task.id, e);
      return copy(e.task);
    },
    async boardUpdate(repo, id, patch, expectedUpdated) {
      const e = await entryOf(repo, id);
      if (expectedUpdated !== undefined && expectedUpdated !== e.task.updated) {
        return reject("board_conflict", JSON.stringify(e.task));
      }
      if (patch.title !== undefined && (!oneLine(patch.title) || oneLine(patch.title).length > TITLE_MAX)) {
        return reject("io", "the title is empty or too long");
      }
      apply(e, patch, stamp());
      return copy(e.task);
    },
    async boardDelete(repo, id) {
      await entryOf(repo, id);
      const b = of(repo);
      b.tasks.delete(id);
      b.links.delete(id);
    },
    async boardCreateMany(repo, drafts) {
      const b = of(repo);
      const taken = new Set<string>();
      const now = stamp();
      const built: Entry[] = [];
      for (const d of drafts) {
        const id = randomId((x) => b.tasks.has(x) || taken.has(x));
        taken.add(id);
        built.push(await build(id, d, now));
      }
      for (const e of built) b.tasks.set(e.task.id, e);
      return built.map((e) => copy(e.task));
    },
    async boardLinks(repo) {
      const b = of(repo);
      for (const id of [...b.links.keys()]) if (!b.tasks.has(id)) b.links.delete(id);
      return [...b.links.values()].sort((a, c) => a.id.localeCompare(c.id));
    },
    async boardLinkSet(repo, id, link) {
      if (!ID.test(id)) return reject("board_bad_id");
      const b = of(repo);
      if (link) b.links.set(id, { ...link, id });
      else b.links.delete(id);
    },
    __boardEditOutside(repo, id, patch) {
      const e = of(repo).tasks.get(id);
      if (e) apply(e, patch, stamp());
    },
    __boardFiles(repo) {
      const b = of(repo);
      return [
        ...[...b.tasks.values()].map((e) => ({ file: e.task.file, text: render(e) })),
        ...b.unreadable.map((u) => ({ file: u.file, text: u.text })),
      ].sort((a, c) => a.file.localeCompare(c.file));
    },
  };
}
