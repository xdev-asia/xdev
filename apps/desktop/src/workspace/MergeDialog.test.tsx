import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { mount, tick, type Node } from "@/kit/testHooks";
import { MergeDialog } from "./MergeDialog";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

afterEach(() => vi.unstubAllGlobals());

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const Dlg = MergeDialog as unknown as (p: Parameters<typeof MergeDialog>[0]) => ReactElement;
const sources = [
  { id: "a", title: "Fix login", agent: "Claude" },
  { id: "b", title: "Empty", agent: "Shell" },
  { id: "c", title: "Docs", agent: "Codex" },
];
const out: Record<string, string> = { a: "\u001b[32mok\u001b[0m\r\n", b: "", c: "written\n" };

function setup() {
  const saved: string[] = [];
  const api = {
    termTailRead: vi.fn(async (id: string) => out[id] ?? ""),
    transcriptSave: vi.fn(async (_name: string, text: string) => {
      saved.push(text);
      return "/tmp/merged-output.txt";
    }),
  };
  const m = mount(Dlg, () => ({ api, sources, onClose() {} }));
  return { api, m, saved };
}

const text = (m: ReturnType<typeof setup>["m"]) => m.all().find((n) => n.props.className === "merge-pre")?.props.children;

it("merges the tabs' output with a header each and skips the empty one", async () => {
  const { m } = setup();
  await m.settle();
  expect(text(m)).toBe("=== Fix login (Claude) ===\nok\n\n=== Docs (Codex) ===\nwritten");
});

it("copies the merged text and saves it through the save dialog", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const { m, saved, api } = setup();
  await m.settle();
  (m.draw() as Node).props.onConfirm();
  await tick();
  expect(writeText).toHaveBeenCalledWith("=== Fix login (Claude) ===\nok\n\n=== Docs (Codex) ===\nwritten");
  const save = m.all().find((n) => n.type === "button" && n.props.children === en("merge.save"))!;
  save.props.onClick();
  await tick();
  expect(api.transcriptSave).toHaveBeenCalledTimes(1);
  expect(saved[0]).toContain("=== Docs (Codex) ===");
});

it("has nothing to copy when no tab has output", async () => {
  const api = { termTailRead: vi.fn(async () => ""), transcriptSave: vi.fn(async () => null) };
  const m = mount(Dlg, () => ({ api, sources, onClose() {} }));
  await m.settle();
  expect((m.draw() as Node).props.confirmDisabled).toBe(true);
  expect(text(m)).toBeUndefined();
});
