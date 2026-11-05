import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { DiffView } from "@/components/DiffView";
import { translate } from "@/i18n";
import { CompareBody, readDisk, type DiskState } from "./CompareDialog";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const body = (state: DiskState) => nodes(CompareBody({ state, current: "mine" }));
const words = (state: DiskState) => body(state).map((n) => n.props.children).filter((c) => typeof c === "string");

it("reads the disk text of a text file", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "fileRead").mockResolvedValue({ text: "disk", kind: "text", hash: "h", eol: "lf", size: 4 } as never);
  expect(await readDisk(api, "/w", "a.ts")).toEqual({ kind: "text", disk: "disk" });
});

it("a file that is not text, or cannot be read, has nothing to compare", async () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "fileRead").mockResolvedValue({ text: null, kind: "binary", hash: null, eol: "lf", size: 4 } as never);
  expect(await readDisk(api, "/w", "a.ts")).toEqual({ kind: "binary" });
  read.mockRejectedValue({ code: "not_found" });
  expect(await readDisk(api, "/w", "a.ts")).toEqual({ kind: "error", error: "not_found" });
});

it("each state says what it is", () => {
  expect(words({ kind: "reading" })).toEqual([en("files.external.reading")]);
  expect(words({ kind: "binary" })).toEqual([en("files.external.binary")]);
  expect(words({ kind: "error", error: "not_found" })).toEqual([en("files.external.readError", { error: en("error.not_found") })]);
});

it("the diff has the disk version as base and the buffer as current", () => {
  const diff = body({ kind: "text", disk: "disk" }).find((n) => n.type === DiffView)!;
  expect(diff.props).toMatchObject({ base: "disk", current: "mine" });
});
