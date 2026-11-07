import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { mount, textOf, tick, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { CliPage, cliState } from "./CliPage";
import { SECTIONS } from "../sections";
import { runSearch } from "../searchModel";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

async function open(status: Parameters<ReturnType<typeof createMockApi>["__cliSetStatus"]>[0] = {}) {
  const api = createMockApi({});
  api.__cliSetStatus(status);
  const m = mount(CliPage, () => ({ api, onChanged: vi.fn() }));
  await m.settle();
  await m.settle();
  return { api, m };
}
const act = (all: Node[], name: string) => all.find((n) => n.props["data-act"] === name);
const nodesOf = (m: Awaited<ReturnType<typeof open>>["m"]) => m.all();

it("is a section of Settings and is found by search", () => {
  expect(SECTIONS.find((s) => s.id === "cli")!.Component).toBe(CliPage);
  expect(runSearch("path", (k) => translate("en", k), (id) => id).ids.has("cli.status")).toBe(true);
});

it("maps the status to one state", () => {
  const base = { installed: true, targetPath: "/a", linkPath: "/b", onPath: true, stale: false };
  expect(cliState(null)).toBe("checking");
  expect(cliState({ ...base, installed: false })).toBe("notInstalled");
  expect(cliState(base)).toBe("installed");
  expect(cliState({ ...base, onPath: false })).toBe("notOnPath");
  expect(cliState({ ...base, stale: true, installed: false })).toBe("stale");
});

it("not installed offers one primary Install and installs", async () => {
  const { api, m } = await open();
  const all = nodesOf(m);
  const install = act(all, "install")!;
  expect(install.props.variant).toBeUndefined();
  expect(textOf(install)).toBe("Install command");
  expect(act(all, "reveal")!.props.variant).toBe("secondary");
  install.props.onClick();
  await tick();
  expect(api.__cliInstallCalls()).toEqual(["install"]);
  await m.settle();
  const after = nodesOf(m);
  expect(act(after, "remove")).toBeDefined();
  expect(act(after, "install")).toBeUndefined();
});

it("installed offers Remove, and removes", async () => {
  const { api, m } = await open({ installed: true });
  const remove = act(nodesOf(m), "remove")!;
  expect(remove.props.variant).toBe("secondary");
  remove.props.onClick();
  await tick();
  expect(api.__cliInstallCalls()).toEqual(["remove"]);
});

it("a stale link offers Repair as the primary action", async () => {
  const { api, m } = await open({ installed: false, stale: true });
  const all = nodesOf(m);
  const repair = act(all, "repair")!;
  expect(repair.props.variant).toBe("primary");
  expect(all.some((n) => n.props["data-cli"] === "hint" && textOf(n).includes("gone or old"))).toBe(true);
  repair.props.onClick();
  await tick();
  expect(api.__cliInstallCalls()).toEqual(["repair"]);
});

it("installed but off PATH says to restart the terminal", async () => {
  const { m } = await open({ installed: true, onPath: false });
  const hint = nodesOf(m).find((n) => n.props["data-cli"] === "hint")!;
  expect(textOf(hint)).toContain("Restart your terminal");
  expect(textOf(hint)).toContain("/home/me/.local/bin");
});

it("a build without the binary cannot install", async () => {
  const { m } = await open({ targetPath: null });
  const all = nodesOf(m);
  expect(act(all, "install")!.props.disabled).toBe(true);
  expect(act(all, "reveal")!.props.disabled).toBe(true);
});

it("Reveal asks the backend", async () => {
  const { api, m } = await open();
  act(nodesOf(m), "reveal")!.props.onClick();
  await tick();
  expect(api.__cliInstallCalls()).toEqual(["reveal"]);
});
