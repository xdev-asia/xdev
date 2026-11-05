import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Banner, EmptyState, ListRow } from "@xdev-asia/ui";
import type { Api, ForeignScan, SessionRow } from "@/api";
import { translate } from "@/i18n";
import { mount, nodes, tick, type Node } from "@/kit/testHooks";
import { createMockAgentSessions } from "@/mockAgentSessions";
import { createMockForeignTerms, failingForeignTerms } from "@/mockForeignTerms";
import { createMockSettings, createSettingsHub } from "@/mockSettings";
import { ForeignTermsDialog, type ForeignTermsDialogProps } from "./ForeignTermsDialog";
import { foreignTermsItems, onForeignTermsOpen } from "./foreignTermsEvents";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const Panel = ForeignTermsDialog as unknown as (p: ForeignTermsDialogProps) => ReactElement;

/** Every node, the ListRow slots included (the test does not render parts). */
function deep(all: Node[]): Node[] {
  return all.flatMap((n) => [n, ...(n.type === ListRow ? deep([n.props.title, n.props.meta, n.props.trailing].flatMap(nodes)) : [])]);
}
const text = (n: Node): string =>
  typeof n === "string" || typeof n === "number" ? String(n) : !n || typeof n !== "object" ? "" : [n.props?.children].flat().map((c) => text(c as Node)).join("");

function setup(api: Partial<Pick<Api, "foreignTermsScan" | "agentSessions">> = {}) {
  const sessions = createMockAgentSessions(createMockSettings(createSettingsHub()));
  const calls = { open: [] as string[], resume: [] as SessionRow[], close: 0 };
  const props = {
    api: { ...createMockForeignTerms(), agentSessions: sessions.agentSessions, ...api },
    onClose: () => void calls.close++,
    onOpenFolder: (p: string) => void calls.open.push(p),
    onResume: (r: SessionRow) => void calls.resume.push(r),
  };
  const m = mount(Panel, () => props);
  const all = () => deep(m.all());
  const byLabel = (label: string) => all().find((n) => n.props["aria-label"] === label);
  const status = () => text(all().find((n) => n.props.role === "status")!);
  return { m, all, byLabel, status, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("ForeignTermsDialog", () => {
  it("says it is looking, then lists the rows with app, folder, start and pid", async () => {
    const h = setup();
    expect(h.status()).toBe(en("foreignTerms.loading"));
    await h.m.settle();
    expect(h.status()).toBe(en("foreignTerms.count", { count: 3 }));
    const items = h.all().filter((n) => n.type === "li");
    expect(items.map((n) => n.props["aria-label"])).toEqual([
      en("foreignTerms.rowLabel", { name: "Claude Code", pid: 48211 }),
      en("foreignTerms.rowLabel", { name: "Codex", pid: 51034 }),
      en("foreignTerms.rowLabel", { name: "zsh", pid: 40102 }),
    ]);
    const meta = h.all().filter((n) => n.props.className === "ft-meta").map(text);
    expect(meta[0]).toBe(`Terminal · /demo/xdev · ${en("foreignTerms.started", { ago: "1 h" })} · pid 48211`);
    // Agent rows carry the tag; the shell does not.
    expect(h.all().filter((n) => text(n) === en("foreignTerms.agent") && n.props.className !== "ft-title")).toHaveLength(2);
  });

  it("offers open as project only for a folder, and resume only for a known session", async () => {
    const h = setup();
    await h.m.settle();
    expect(h.byLabel(en("foreignTerms.openFolderLabel", { path: "/demo/xdev" }))).toBeDefined();
    expect(h.byLabel(en("foreignTerms.openFolderLabel", { path: "/demo/gone" }))).toBeUndefined();
    expect(h.byLabel(en("foreignTerms.resumeLabel", { name: "Claude Code" }))).toBeDefined();
    expect(h.byLabel(en("foreignTerms.resumeLabel", { name: "Codex" }))).toBeUndefined();
    h.byLabel(en("foreignTerms.openFolderLabel", { path: "/demo/site" }))!.props.onClick();
    expect(h.calls.open).toEqual(["/demo/site"]);
  });

  it("resumes the indexed session through the session list", async () => {
    const h = setup();
    await h.m.settle();
    h.byLabel(en("foreignTerms.resumeLabel", { name: "Claude Code" }))!.props.onClick();
    await tick();
    await tick();
    expect(h.calls.resume.map((r) => [r.session.id, r.worktree])).toEqual([["0b1e6f3a-demo-0001", "/demo/xdev"]]);
  });

  it("says so when the session list no longer has the session", async () => {
    const h = setup({ agentSessions: async () => [] });
    await h.m.settle();
    h.byLabel(en("foreignTerms.resumeLabel", { name: "Claude Code" }))!.props.onClick();
    await tick();
    await tick();
    expect(h.calls.resume).toEqual([]);
    expect(h.status()).toBe(en("foreignTerms.resumeMissing"));
  });

  it("copies the pid and announces it", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const h = setup();
    await h.m.settle();
    h.all().find((n) => n.props.label === en("foreignTerms.copyPid", { pid: 51034 }))!.props.onClick();
    await tick();
    expect(writeText).toHaveBeenCalledWith("51034");
    expect(h.status()).toBe(en("foreignTerms.copied", { pid: 51034 }));
  });

  it("shows the empty state", async () => {
    const h = setup({ foreignTermsScan: async (): Promise<ForeignScan> => ({ rows: [], truncated: false }) });
    const all = await h.m.settle();
    const empty = all.find((n) => n.type === EmptyState);
    expect(empty?.props.title).toBe(en("foreignTerms.empty"));
    expect(all.some((n) => n.type === "ul")).toBe(false);
  });

  it("says the list was cut at the row limit", async () => {
    const rows = (await createMockForeignTerms().foreignTermsScan()).rows;
    const h = setup({ foreignTermsScan: async () => ({ rows, truncated: true }) });
    await h.m.settle();
    expect(h.status()).toBe(en("foreignTerms.truncated", { count: 3 }));
  });

  it("shows the error and loads again on refresh", async () => {
    const scan = vi.fn(failingForeignTerms("timeout").foreignTermsScan);
    const h = setup({ foreignTermsScan: scan });
    const all = await h.m.settle();
    const banner = all.find((n) => n.type === Banner);
    expect(banner?.props.title).toBe(en("foreignTerms.failed"));
    expect(banner?.props.children).toBe(en("foreignTerms.failed.timeout"));
    scan.mockImplementation(createMockForeignTerms().foreignTermsScan);
    all.find((n) => n.props.icon === "refresh")!.props.onClick();
    const next = await h.m.settle();
    expect(next.some((n) => n.type === Banner)).toBe(false);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("closes with the one primary button and Escape", async () => {
    const h = setup();
    const all = await h.m.settle();
    const dialog = all[0];
    expect(dialog.props.modal).toBe(true);
    expect(dialog.props.cancelLabel).toBeNull();
    dialog.props.onConfirm();
    dialog.props.onCancel();
    expect(h.calls.close).toBe(2);
  });
});

it("the palette item opens the host", () => {
  const opened = vi.fn();
  const off = onForeignTermsOpen(opened);
  const [item] = foreignTermsItems(en);
  expect(item.title).toBe("Terminals on this machine");
  item.run();
  expect(opened).toHaveBeenCalledTimes(1);
  off();
  item.run();
  expect(opened).toHaveBeenCalledTimes(1);
});
