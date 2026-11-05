import { expect, it, vi } from "vitest";
import { createMockApi, type Api, type SkillStatus } from "@/api";
import { translate } from "@/i18n";
import { mount, nodes, textOf, type Node } from "@/kit/testHooks";
import { ORCHESTRATION_DEFAULTS } from "@/mockSettings";
import { OrchestrationPage } from "./OrchestrationPage";
import { HowToCards, HowToDialog } from "./HowToCards";
import { SkillCard, UninstallControl } from "./SkillCard";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const act = (all: Node[], name: string) => all.find((n) => n.props["data-act"] === name);
const field = (all: Node[], name: string) => all.find((n) => n.props["data-field"] === name)!;

const STATUS: SkillStatus = {
  installed: false,
  edited: false,
  canonical: "/home/u/.agents/skills/xdev-orchestration",
  agents: [
    { id: "claude", name: "Claude", detected: true, ready: false, path: null },
    { id: "codex", name: "Codex", detected: true, ready: true, path: null },
  ],
  installCommand: "xdev skills install",
};

function open(over: Partial<Api> = {}) {
  const api = { ...createMockApi({}), orchestrationSkillStatus: async () => structuredClone(STATUS), ...over } as Api;
  const m = mount(OrchestrationPage, () => ({ api, onChanged: vi.fn() }));
  return { api, m };
}
const skillCard = (all: Node[]) => all.find((n) => n.type === SkillCard)!;

it("shows the title, the skill card as Checking until the status arrives, then the status", async () => {
  const { m } = open();
  const first = m.all();
  expect(first.some((n) => n.type === "h3" && n.props.children === en("settings.orchestration.title"))).toBe(true);
  expect(skillCard(first).props.status).toBeNull();
  const all = await m.settle();
  expect(skillCard(all).props.status).toEqual(STATUS);
});

it("Install calls the api once, refreshes the status, and is busy meanwhile", async () => {
  let release!: (s: SkillStatus) => void;
  const install = vi.fn(() => new Promise<SkillStatus>((r) => (release = r)));
  const { m } = open({ orchestrationSkillInstall: install });
  let all = await m.settle();
  skillCard(all).props.onInstall();
  skillCard(all).props.onInstall();
  expect(install).toHaveBeenCalledTimes(1);
  expect(install).toHaveBeenCalledWith();
  expect(skillCard(m.all()).props.busy).toBe(true);
  release({ ...STATUS, installed: true });
  await new Promise((r) => setTimeout(r, 0));
  all = m.all();
  expect(skillCard(all).props.busy).toBe(false);
  expect(skillCard(all).props.status.installed).toBe(true);
});

it("Uninstall calls the api and shows the new status; the card offers it only once installed", async () => {
  const uninstall = vi.fn(async () => structuredClone(STATUS));
  const { m } = open({ orchestrationSkillStatus: async () => ({ ...STATUS, installed: true }), orchestrationSkillUninstall: uninstall });
  const all = await m.settle();
  skillCard(all).props.onUninstall();
  await new Promise((r) => setTimeout(r, 0));
  expect(uninstall).toHaveBeenCalledTimes(1);
  expect(skillCard(m.all()).props.status.installed).toBe(false);
  const card = (installed: boolean) => nodes(SkillCard({ status: { ...STATUS, installed }, busy: false, copied: false, onInstall() {}, onUninstall() {}, onRecheck() {}, onCopyCommand() {} }));
  expect(card(true).some((n) => n.type === UninstallControl)).toBe(true);
  expect(card(false).some((n) => n.type === UninstallControl)).toBe(false);
  // The control is a secondary button.
  const button = mount(UninstallControl, () => ({ busy: false, onUninstall() {} })).all().find((n) => n.props["data-act"] === "uninstall");
  expect(button?.props.variant).toBe("secondary");
});

it("an install error shows inline and keeps the old status", async () => {
  const { m } = open({ orchestrationSkillInstall: async () => Promise.reject({ code: "io", message: "x" }) });
  let all = await m.settle();
  skillCard(all).props.onInstall();
  await new Promise((r) => setTimeout(r, 0));
  all = m.all();
  expect(skillCard(all).props.error).toBeDefined();
  expect(skillCard(all).props.status).toEqual(STATUS);
  const card = nodes(SkillCard({ ...skillCard(all).props } as never));
  expect(card.some((n) => n.props["data-error"] === "skill" && n.props.role === "alert")).toBe(true);
});

it("Re-check reads the status again", async () => {
  const status = vi.fn(async () => structuredClone(STATUS));
  const { m } = open({ orchestrationSkillStatus: status });
  const all = await m.settle();
  expect(status).toHaveBeenCalledTimes(1);
  skillCard(all).props.onRecheck();
  await new Promise((r) => setTimeout(r, 0));
  expect(status).toHaveBeenCalledTimes(2);
});

it("the skill card shows chips for detected agents and the coverage sentence", () => {
  const props = { status: STATUS, busy: false, copied: false, onInstall() {}, onRecheck() {}, onCopyCommand() {} };
  const all = nodes(SkillCard(props));
  const chips = all.filter((n) => n.props["data-agent"]);
  expect(chips.map((c) => [c.props["data-agent"], c.props["data-ready"]])).toEqual([["claude", false], ["codex", true]]);
  const line = all.find((n) => n.props["data-coverage"] === "line")!;
  expect(textOf(line)).toContain("1 of 2 detected agents have the skill.");
  expect(textOf(line)).toContain(en("settings.orchestration.coverage.hint"));
  // Install is the one primary button.
  expect(act(all, "install")!.props.variant).toBeUndefined();
  expect(act(all, "recheck")!.props.variant).toBe("secondary");
  expect(act(all, "copy-command")!.props.variant).toBe("secondary");
  // Checking state and the none state.
  const loading = nodes(SkillCard({ ...props, status: null }));
  expect(textOf(loading.find((n) => n.props["data-coverage"] === "line")!)).toBe(en("settings.orchestration.coverage.checking"));
  const none = nodes(SkillCard({ ...props, status: { ...STATUS, agents: [] } }));
  expect(textOf(none.find((n) => n.props["data-coverage"] === "line")!)).toBe(en("settings.orchestration.coverage.none"));
});

it("depth: loads the stored value, commits a clamped value, ignores junk", async () => {
  const { api, m } = open();
  const put = vi.spyOn(api, "orchestrationSettingsPut");
  let all = await m.settle();
  expect(field(all, "depth").props.value).toBe("1");
  field(all, "depth").props.onChange({ target: { value: "42" } });
  field(m.all(), "depth").props.onBlur();
  await new Promise((r) => setTimeout(r, 0));
  expect(put).toHaveBeenCalledWith({ ...ORCHESTRATION_DEFAULTS, nestedWorkerMaxDepth: 9, workerAutoClose: true });
  all = m.all();
  expect(field(all, "depth").props.value).toBe("9");
  field(all, "depth").props.onChange({ target: { value: "abc" } });
  field(m.all(), "depth").props.onBlur();
  await new Promise((r) => setTimeout(r, 0));
  expect(put).toHaveBeenCalledTimes(1);
  expect(field(m.all(), "depth").props.value).toBe("9");
});

it("the auto-close switch flips and saves", async () => {
  const { api, m } = open();
  const put = vi.spyOn(api, "orchestrationSettingsPut");
  const all = await m.settle();
  const sw = act(all, "auto-close")!;
  expect(sw.props["aria-checked"]).toBe(true);
  sw.props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  expect(put).toHaveBeenCalledWith({ ...ORCHESTRATION_DEFAULTS, nestedWorkerMaxDepth: 1, workerAutoClose: false });
  expect(act(m.all(), "auto-close")!.props["aria-checked"]).toBe(false);
});

it("how-to: five tiles, a tile opens the dialog whose Copy prompt copies the prompt text", () => {
  const onCopy = vi.fn();
  const onOpen = vi.fn();
  const all = nodes(HowToCards({ open: null, copied: false, onOpen, onClose() {}, onCopy }));
  const tiles = all.filter((n) => n.props.icon && n.props.title);
  expect(tiles).toHaveLength(5);
  tiles[2]!.props.onClick();
  expect(onOpen).toHaveBeenCalledWith("child-sequence");
  const dlg = mount(HowToDialog, () => ({ id: "child-sequence" as const, copied: false, onClose() {}, onCopy }));
  const inner = dlg.all();
  const prompt = en("settings.orchestration.howTo.child-sequence.prompt");
  expect(textOf(inner.find((n) => n.props["data-howto"] === "prompt")!)).toBe(prompt);
  act(inner, "copy-prompt")!.props.onClick();
  expect(onCopy).toHaveBeenCalledWith(prompt);
});

it("Replace edited copy installs with force; Install stays the only primary button", async () => {
  const install = vi.fn(async (_force?: boolean) => ({ ...STATUS, installed: true, edited: false }));
  const { m } = open({ orchestrationSkillStatus: async () => ({ ...STATUS, installed: true, edited: true }), orchestrationSkillInstall: install });
  const all = await m.settle();
  skillCard(all).props.onReplace();
  expect(install).toHaveBeenCalledWith(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(skillCard(m.all()).props.status.edited).toBe(false);
});

it("the skill card offers Replace edited copy only for an edited skill, as a secondary button", () => {
  const base = { busy: false, copied: false, onInstall() {}, onRecheck() {}, onCopyCommand() {}, onReplace() {} };
  const edited = nodes(SkillCard({ ...base, status: { ...STATUS, installed: true, edited: true } }));
  const replace = act(edited, "replace")!;
  expect(replace.props.variant).toBe("secondary");
  expect(replace.props.children).toBe(en("settings.orchestration.skill.replace"));
  expect(edited.filter((n) => n.props["data-act"] && n.props.variant === undefined).map((n) => n.props["data-act"])).toEqual(["install"]);
  expect(act(nodes(SkillCard({ ...base, status: { ...STATUS, installed: true } })), "replace")).toBeUndefined();
});

it("a change made while a save runs is applied after it, on top of what was stored", async () => {
  const releases: (() => void)[] = [];
  const put = vi.fn((v: { nestedWorkerMaxDepth: number; workerAutoClose: boolean }) => new Promise<typeof v>((r) => releases.push(() => r(v))));
  const { m } = open({ orchestrationSettingsPut: put as never });
  let all = await m.settle();
  act(all, "auto-close")!.props.onClick();
  field(m.all(), "depth").props.onChange({ target: { value: "3" } });
  field(m.all(), "depth").props.onBlur();
  expect(put).toHaveBeenCalledTimes(1);
  releases[0]!();
  await new Promise((r) => setTimeout(r, 0));
  expect(put).toHaveBeenCalledTimes(2);
  expect(put.mock.calls[1]![0]).toEqual({ ...ORCHESTRATION_DEFAULTS, nestedWorkerMaxDepth: 3, workerAutoClose: false });
  releases[1]!();
  await new Promise((r) => setTimeout(r, 0));
  all = m.all();
  expect(field(all, "depth").props.value).toBe("3");
});
