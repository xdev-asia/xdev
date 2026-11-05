import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import type { SessionRow, SessionTurn } from "@/api";
import { clip, SessionDetails, SkippedBanner, TURN_SHOW_CHARS } from "./SessionDetails";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

// useState values come from `seed` by call order; setters are recorded; effects run at once.
let seed: Record<number, unknown> = {};
let call = 0;
const setters: Array<(v: unknown) => void> = [];
const sets: unknown[][] = [];
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (init: unknown) => {
    const i = call++;
    const set = (v: unknown) => (sets[i] ??= []).push(v);
    setters[i] = set;
    return [seed[i] ?? init, set];
  },
  useEffect: (fn: () => void) => {
    fn();
  },
}));

const row = {
  session: { key: "h:s1", id: "s1", homeId: "h", agent: "codex", cwd: "/p/app/src", branch: null, model: null, title: "Add the parser", messages: 4, first: Date.UTC(2026, 10, 2, 10), last: Date.UTC(2026, 10, 3, 9) },
  worktree: "/p/app",
  repo: "/p/app",
  resumable: true,
} as unknown as SessionRow;

const turns: SessionTurn[] = [
  { role: "user", text: "Fix the parser", at: 1 },
  { role: "assistant", text: "Done, the parser <b>now</b> works", at: 2 },
];

beforeEach(() => {
  seed = {};
  call = 0;
  sets.length = 0;
});

const render = (loadTail = vi.fn(async () => turns), over: Partial<Parameters<typeof SessionDetails>[0]> = {}) => {
  call = 0;
  return { loadTail, html: renderToStaticMarkup(<SessionDetails row={row} loadTail={loadTail} onViewLog={() => {}} onClose={() => {}} {...over} />) };
};

describe("SessionDetails", () => {
  it("reads the tail of the row's session once and shows the facts", () => {
    const { loadTail, html } = render();
    expect(loadTail).toHaveBeenCalledTimes(1);
    expect(loadTail).toHaveBeenCalledWith(row);
    for (const part of ["Add the parser", "Codex", "app", "Started", "Updated", "Reading the log"]) expect(html).toContain(part);
  });

  it("hands what the api returned to its state", async () => {
    const { loadTail } = render();
    await loadTail.mock.results[0]!.value;
    expect(sets[0]).toEqual([null, turns]);
  });

  it("shows the turns as text, in order, with the role of each", () => {
    seed = { 0: turns };
    const { html } = render();
    expect(html.indexOf("Fix the parser")).toBeLessThan(html.indexOf("Done, the parser"));
    expect(html).toContain("&lt;b&gt;now&lt;/b&gt;");
    expect(html).not.toContain("<b>now</b>");
    expect(html).toContain("You");
  });

  it("says so when the log has no turns or cannot be read", () => {
    seed = { 0: [] };
    expect(render().html).toContain("No text turns");
    seed = { 1: true };
    expect(render().html).toContain("Couldn&#x27;t read the log");
  });

  it("has a View log and a Close button, both secondary", () => {
    const { html } = render();
    expect(html).toContain("View log");
    expect(html).toContain("Close details");
    expect(html).not.toMatch(/class="btn"/);
  });

  it("rejects quietly: a failing read marks the pane failed", async () => {
    const fail = vi.fn(async () => {
      throw { code: "bad_path" };
    });
    render(fail as never);
    await fail.mock.results[0]!.value.catch(() => {});
    await Promise.resolve();
    expect(sets[1]).toEqual([false, true]);
  });
});

describe("clip", () => {
  it("cuts long text to the cap with an ellipsis and leaves short text alone", () => {
    expect(clip("short")).toBe("short");
    const out = clip("x".repeat(TURN_SHOW_CHARS + 50));
    expect(Array.from(out)).toHaveLength(TURN_SHOW_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("SkippedBanner", () => {
  it("shows nothing for a zero count", () => {
    expect(renderToStaticMarkup(<SkippedBanner count={0} paths={[]} />)).toBe("");
  });

  it("shows the count with a Show details button, the list closed", () => {
    call = 0;
    const html = renderToStaticMarkup(<SkippedBanner count={3} paths={["/a.jsonl", "/b.jsonl"]} />);
    expect(html).toContain("3 logs were skipped");
    expect(html).toContain("Show details");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("/a.jsonl");
  });

  it("lists at most 20 paths when open", () => {
    seed = { 0: true };
    call = 0;
    const paths = Array.from({ length: 25 }, (_, i) => `/log-${i}.jsonl`);
    const html = renderToStaticMarkup(<SkippedBanner count={25} paths={paths} />);
    expect(html).toContain("/log-0.jsonl");
    expect(html).toContain("/log-19.jsonl");
    expect(html).not.toContain("/log-20.jsonl");
    expect(html).toContain("Hide details");
  });
});
