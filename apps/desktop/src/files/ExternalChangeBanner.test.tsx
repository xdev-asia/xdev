import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { ExternalChangeBanner, needsChoice } from "./ExternalChangeBanner";
import { fileTabs } from "./fileTabs";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const W = "C:/wt/a";
const disk = (text: string, hash: string) => ({ text, kind: "text", hash, eol: "lf", size: text.length }) as never;

function setup() {
  const api = createMockApi({});
  fileTabs.open(W, "a.ts");
  fileTabs.loaded(W, "a.ts", disk("one", "h1"));
  const io = { api, store: fileTabs, t };
  const onCompare = vi.fn();
  const bar = () => nodes(ExternalChangeBanner({ io, entry: fileTabs.get(W, "a.ts")!, onCompare }));
  const buttons = () => bar().filter((n) => n.type === "button" || n.type === Button);
  const named = (label: string) => buttons().find((n) => n.props.children === label)!;
  return { api, onCompare, bar, buttons, named };
}

beforeEach(() => { fileTabs.reset(); resetToastsForTests(); });
afterEach(() => { fileTabs.reset(); vi.restoreAllMocks(); });

it("a changed file with edits shows four buttons, exactly one of them primary", () => {
  const { buttons } = setup();
  fileTabs.edit(W, "a.ts", "mine");
  fileTabs.markExternal(W, "a.ts", "changed");
  expect(buttons().map((n) => n.props.children)).toEqual([
    t("files.external.compare"),
    t("files.external.reload"),
    t("files.external.keep"),
    t("files.conflict.overwrite"),
  ]);
  expect(buttons().filter((n) => n.type === Button)).toHaveLength(1);
});

it("Overwrite is hidden when there is nothing to write", () => {
  const { buttons } = setup();
  fileTabs.markExternal(W, "a.ts", "changed");
  expect(buttons().map((n) => n.props.children)).not.toContain(t("files.conflict.overwrite"));
});

it("the words follow the cause", () => {
  const { bar } = setup();
  fileTabs.edit(W, "a.ts", "mine");
  fileTabs.conflict(W, "a.ts", "d");
  expect(bar().some((n) => n.props.children === t("files.conflict.body"))).toBe(true);
  fileTabs.markExternal(W, "a.ts", "changed");
  expect(bar().some((n) => n.props.children === t("files.external.body"))).toBe(true);
});

it("needsChoice is true for a save conflict or a changed mark only", () => {
  setup();
  const e = () => fileTabs.get(W, "a.ts")!;
  expect(needsChoice(e())).toBe(false);
  fileTabs.markExternal(W, "a.ts", "deleted");
  expect(needsChoice(e())).toBe(false);
  fileTabs.markExternal(W, "a.ts", "changed");
  expect(needsChoice(e())).toBe(true);
  fileTabs.keepMine(W, "a.ts");
  fileTabs.conflict(W, "a.ts", "d");
  expect(needsChoice(e())).toBe(true);
});

it("Compare calls onCompare", () => {
  const { named, onCompare } = setup();
  fileTabs.markExternal(W, "a.ts", "changed");
  named(t("files.external.compare")).props.onClick();
  expect(onCompare).toHaveBeenCalledTimes(1);
});

it("Reload drops the edits and offers Undo, which puts them back", async () => {
  const { api, named } = setup();
  vi.spyOn(api, "fileRead").mockResolvedValue(disk("from disk", "h2"));
  fileTabs.edit(W, "a.ts", "mine");
  fileTabs.markExternal(W, "a.ts", "changed");
  named(t("files.external.reload")).props.onClick();
  await tick();
  expect(fileTabs.get(W, "a.ts")).toMatchObject({ text: "from disk", saved: "from disk", external: null, conflict: null });
  const toast = getToasts().at(-1)!;
  expect(toast.text).toBe(t("files.external.reloaded", { name: "a.ts" }));
  expect(toast.actions.map((a) => a.label)).toEqual([t("files.external.undo")]);
  toast.actions[0]!.run();
  expect(fileTabs.get(W, "a.ts")).toMatchObject({ text: "mine", saved: "one", hash: "h1", external: null });
});

it("Keep my edits clears the banner, adopts the disk hash and writes nothing", async () => {
  const { api, named } = setup();
  vi.spyOn(api, "fileRead").mockResolvedValue(disk("from disk", "h2"));
  const write = vi.spyOn(api, "fileWrite").mockResolvedValue({ type: "saved", hash: "h3" });
  fileTabs.edit(W, "a.ts", "mine");
  fileTabs.markExternal(W, "a.ts", "changed");
  named(t("files.external.keep")).props.onClick();
  await tick();
  expect(fileTabs.get(W, "a.ts")).toMatchObject({ text: "mine", hash: "h2", external: null });
  expect(needsChoice(fileTabs.get(W, "a.ts")!)).toBe(false);
  expect(write).not.toHaveBeenCalled();
});

it("Overwrite after a changed mark writes over the disk version it found", async () => {
  const { api, named } = setup();
  vi.spyOn(api, "fileRead").mockResolvedValue(disk("from disk", "h2"));
  const write = vi.spyOn(api, "fileWrite").mockResolvedValue({ type: "saved", hash: "h3" });
  fileTabs.edit(W, "a.ts", "mine");
  fileTabs.markExternal(W, "a.ts", "changed");
  named(t("files.conflict.overwrite")).props.onClick();
  await tick();
  expect(write).toHaveBeenCalledWith(W, "a.ts", "mine", "lf", "h2");
  expect(fileTabs.get(W, "a.ts")).toMatchObject({ saved: "mine", hash: "h3", external: null });
});

it("Overwrite after a save conflict writes over the hash the save found; a file that is gone is created", async () => {
  const { api, named } = setup();
  const write = vi.spyOn(api, "fileWrite").mockResolvedValue({ type: "saved", hash: "h3" });
  fileTabs.edit(W, "a.ts", "mine");
  fileTabs.conflict(W, "a.ts", "disk9");
  named(t("files.conflict.overwrite")).props.onClick();
  await tick();
  expect(write).toHaveBeenLastCalledWith(W, "a.ts", "mine", "lf", "disk9");

  fileTabs.edit(W, "a.ts", "mine2");
  fileTabs.conflict(W, "a.ts", "");
  named(t("files.conflict.overwrite")).props.onClick();
  await tick();
  expect(write).toHaveBeenLastCalledWith(W, "a.ts", "mine2", "lf", null);
});
