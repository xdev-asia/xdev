import { expect, it } from "vitest";
import { translate } from "@/i18n";
import { entriesFor } from "./catalog";
import { runSearch } from "./searchModel";

const t = (k: string) => translate("en", k);
const title = (s: string) => t(`${s === "editor" ? "files.settings" : s === "openIn" ? "openIn" : s === "keys" ? "keys" : s === "qcmd" ? "qcmd" : `settings.${s}`}.title`);

it("an empty query keeps every entry and every section", () => {
  const r = runSearch("", t, title);
  expect(r.active).toBe(false);
  expect(r.ids.size).toBe(entriesFor().length);
  expect(r.best).toBeNull();
});

it("font finds the appearance, terminal and editor rows only", () => {
  const r = runSearch("font", t, title);
  expect(r.active).toBe(true);
  expect(r.ids.has("terminal.fontSize")).toBe(true);
  expect(r.ids.has("editor.fontSize")).toBe(true);
  expect(r.ids.has("git.prefix")).toBe(false);
  expect([...r.counts.keys()].sort()).toEqual(["appearance", "editor", "terminal"]);
  expect(r.counts.get("terminal")).toBeGreaterThan(1);
});

it("the best section is the section of the top hit", () => {
  expect(runSearch("branch prefix", t, title).best).toBe("git");
});

it("a query with no hit is active with nothing found", () => {
  const r = runSearch("zzzzqqq", t, title);
  expect(r.active).toBe(true);
  expect(r.ids.size).toBe(0);
  expect(r.best).toBeNull();
});

it("a section title matches all of its entries", () => {
  const r = runSearch("Vaults", t, title);
  expect([...r.counts.keys()]).toEqual(["vaults"]);
});

it("api key and khóa api find the API keys row", () => {
  for (const query of ["api key", "khóa api", "khoa api", "keychain"]) {
    expect(runSearch(query, t, title).ids.has("usage.apiKeys"), query).toBe(true);
  }
});
