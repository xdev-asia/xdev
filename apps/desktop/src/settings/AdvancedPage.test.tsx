import { expect, it, vi } from "vitest";
import { Button, Field, Textarea } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { mount, textOf, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { AdvancedPage } from "./AdvancedPage";
import { fromDraft, mirrorProblem, parseBypass, proxyProblem } from "./advancedNetwork";
import { SECTIONS } from "./sections";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const t = (key: string) => translate("en", key);
const field = (all: Node[], name: string) => all.find((n) => (n.type === Field || n.type === Textarea) && n.props.name === name)!;

async function open() {
  const api = createMockApi({});
  const put = vi.spyOn(api, "networkSettingsPut");
  const m = mount(AdvancedPage, () => ({ api, onChanged: vi.fn() }));
  await m.settle();
  await m.settle();
  return { api, m, put };
}
const type = (m: { all(): Node[] }, name: string, value: string) => field(m.all(), name).props.onChange({ target: { value } });
const save = (m: { all(): Node[] }) => m.all().find((n) => n.type === Button)!;

it("is a section of Settings, in the Advanced group", () => {
  const section = SECTIONS.find((s) => s.id === "advanced")!;
  expect(section.group).toBe("advanced");
  expect(section.Component).toBe(AdvancedPage);
});

it("renders the four fields, empty, with Save disabled", async () => {
  const { m } = await open();
  const all = m.all();
  expect(textOf(all.find((n) => n.type === "h3")!)).toBe("Advanced");
  for (const name of ["proxyUrl", "noProxy", "nodeMirror", "machineName"]) expect(field(all, name).props.value).toBe("");
  expect(field(all, "machineName").props.placeholder).toBe("this-machine");
  expect(save(m).props.disabled).toBe(true);
});

it("shows an inline message for a bad proxy and blocks saving", async () => {
  const { m, put } = await open();
  type(m, "proxyUrl", "ftp://proxy.corp");
  expect(field(m.all(), "proxyUrl").props.error).toBe(t("settings.advanced.proxy.scheme"));
  expect(save(m).props.disabled).toBe(true);
  type(m, "proxyUrl", "proxy.corp");
  expect(field(m.all(), "proxyUrl").props.error).toBe(t("settings.advanced.proxy.invalid"));
  type(m, "nodeMirror", "socks5://x");
  expect(field(m.all(), "nodeMirror").props.error).toBe(t("settings.advanced.mirror.scheme"));
  save(m).props.onClick();
  expect(put).not.toHaveBeenCalled();
});

it("saves the cleaned values through the put command", async () => {
  const { m, put } = await open();
  type(m, "proxyUrl", " http://127.0.0.1:8080 ");
  type(m, "noProxy", "localhost\n\n.corp.example, localhost");
  type(m, "nodeMirror", "https://registry.npmmirror.com");
  type(m, "machineName", " dev box ");
  expect(field(m.all(), "proxyUrl").props.error).toBeUndefined();
  expect(save(m).props.disabled).toBe(false);
  save(m).props.onClick();
  await m.settle();
  expect(put).toHaveBeenCalledWith({
    proxyUrl: "http://127.0.0.1:8080",
    noProxy: ["localhost", ".corp.example"],
    nodeMirror: "https://registry.npmmirror.com",
    machineName: "dev box",
    http1Only: false,
  });
  await m.settle();
  expect(field(m.all(), "noProxy").props.value).toBe("localhost\n.corp.example");
  expect(save(m).props.disabled).toBe(true);
});

it("validates like the app does", () => {
  expect(proxyProblem("")).toBeUndefined();
  expect(proxyProblem("socks5://localhost:1080")).toBeUndefined();
  expect(proxyProblem("localhost:8080")).toBe("scheme");
  expect(proxyProblem("http://")).toBe("invalid");
  expect(mirrorProblem("https://m.example/")).toBeUndefined();
  expect(parseBypass(" a \n\nb,A")).toEqual(["a", "b"]);
  expect(fromDraft({ proxyUrl: "", noProxy: "", nodeMirror: "", machineName: " x ", http1Only: true }).machineName).toBe("x");
});

it("round trips the HTTP/1.1 switch through the put command", async () => {
  const { m, put } = await open();
  const sw = () => m.all().find((n) => n.props?.role === "switch" && n.props["aria-label"] === t("settings.advanced.http1"))!;
  expect(sw().props["aria-checked"]).toBe(false);
  sw().props.onClick();
  expect(sw().props["aria-checked"]).toBe(true);
  save(m).props.onClick();
  await m.settle();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ http1Only: true }));
  await m.settle();
  expect(sw().props["aria-checked"]).toBe(true);
});

it("in Settings the view's SaveBar saves and discards, and the page has no Save button of its own", async () => {
  const api = createMockApi({});
  const put = vi.spyOn(api, "networkSettingsPut");
  const registerSave = vi.fn();
  const m = mount(AdvancedPage, () => ({ api, onChanged: vi.fn(), registerSave }));
  await m.settle();
  await m.settle();
  expect(m.all().some((n) => n.type === Button && n.props["data-act"] === "save-advanced")).toBe(false);
  expect(registerSave).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: false }));
  type(m, "proxyUrl", "http://127.0.0.1:8080");
  await m.settle();
  const spec = registerSave.mock.calls.at(-1)![0];
  expect(spec.dirty).toBe(true);
  spec.onDiscard();
  expect(field(m.all(), "proxyUrl").props.value).toBe("");
  type(m, "proxyUrl", "http://127.0.0.1:8080");
  await m.settle();
  registerSave.mock.calls.at(-1)![0].onSave();
  await m.settle();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ proxyUrl: "http://127.0.0.1:8080" }));
});
