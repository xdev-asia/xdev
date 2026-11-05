import { expect, it } from "vitest";
import { toApiError } from "@/api";
import { createMockComposer } from "./mockComposer";

it("keeps drafts per tab and forgets one on clear", async () => {
  const api = createMockComposer();
  expect(await api.composerDraftGet("a")).toBeNull();
  await api.composerDraftPut("a", "one");
  await api.composerDraftPut("b", "two");
  expect(await api.composerDraftGet("a")).toBe("one");
  expect(await api.composerDraftClear("a")).toBe(true);
  expect(await api.composerDraftClear("a")).toBe(false);
  expect(await api.composerDraftGet("b")).toBe("two");
});

it("rejects a draft over 64 KB as too_large", async () => {
  const api = createMockComposer();
  const err = await api.composerDraftPut("a", "x".repeat(64 * 1024 + 1)).catch((e: unknown) => e);
  expect(toApiError(err).code).toBe("too_large");
});

it("lists templates by name, replaces by id, and stops at 200", async () => {
  const api = createMockComposer();
  await api.promptTemplatesPut({ id: "b", name: "beta", body: "", mode: "insert" });
  const list = await api.promptTemplatesPut({ id: "a", name: "Alpha", body: "x", mode: "append" });
  expect(list.map((x) => x.id)).toEqual(["a", "b"]);
  expect((await api.promptTemplatesPut({ id: "a", name: "Gamma", body: "y", mode: "insert" })).map((x) => x.name)).toEqual(["beta", "Gamma"]);
  expect((await api.promptTemplatesDelete("b")).map((x) => x.id)).toEqual(["a"]);
  for (let i = 0; i < 199; i++) await api.promptTemplatesPut({ id: `t${i}`, name: `t${i}`, body: "", mode: "insert" });
  const err = await api.promptTemplatesPut({ id: "over", name: "over", body: "", mode: "insert" }).catch((e: unknown) => e);
  expect(toApiError(err).code).toBe("too_large");
  const bad = await api.promptTemplatesPut({ id: "no spaces", name: "x", body: "", mode: "insert" }).catch((e: unknown) => e);
  expect(toApiError(bad).code).toBe("kit_bad_input");
});
