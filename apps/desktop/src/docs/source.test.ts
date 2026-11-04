import { describe, expect, it } from "vitest";
import type { VaultView } from "@/api";
import { pickDocsSource } from "./source";

const repo = (id: string, exists = true): VaultView => ({ id: `repo:${id}`, kind: "repo", path: `/r/${id}/docs`, name: id, repoId: id, exists });
const shared = (id: string, exists = true): VaultView => ({ id, kind: "shared", path: `/s/${id}`, name: id, repoId: null, exists });

const A = repo("a");
const B = repo("b");
const S = shared("s1");

describe("pickDocsSource", () => {
  const cases: { name: string; input: Parameters<typeof pickDocsSource>[0]; want: VaultView | null }[] = [
    { name: "the project changed since the saved one: that project's docs", input: { vaults: [A, B, S], saved: S.path, savedRepo: "a", repoId: "b" }, want: B },
    { name: "the first project ever (no saved repo) takes its own docs", input: { vaults: [A, S], saved: null, savedRepo: null, repoId: "a" }, want: A },
    { name: "same project: the saved source wins, even a shared one", input: { vaults: [A, S], saved: S.path, savedRepo: "a", repoId: "a" }, want: S },
    { name: "the project changed but has no docs folder: the saved source", input: { vaults: [A, repo("b", false), S], saved: S.path, savedRepo: "a", repoId: "b" }, want: S },
    { name: "the project is unknown to the list: the saved source", input: { vaults: [A, S], saved: S.path, savedRepo: "a", repoId: "zzz" }, want: S },
    { name: "no current project: the saved source", input: { vaults: [A, S], saved: S.path, savedRepo: null, repoId: null }, want: S },
    { name: "the saved source is gone from the list: the first that exists", input: { vaults: [repo("x", false), A, S], saved: "/s/old", savedRepo: null, repoId: null }, want: A },
    { name: "the saved source is listed but its folder is gone: the first that exists", input: { vaults: [shared("s2", false), S], saved: "/s/s2", savedRepo: null, repoId: null }, want: S },
    { name: "nothing saved: the first that exists", input: { vaults: [repo("x", false), S, A], saved: null, savedRepo: null, repoId: null }, want: S },
    { name: "nothing exists: null", input: { vaults: [repo("x", false), shared("s2", false)], saved: null, savedRepo: null, repoId: "x" }, want: null },
    { name: "no vaults: null", input: { vaults: [], saved: "/s/s1", savedRepo: "a", repoId: "a" }, want: null },
    { name: "paths compare with / and without a trailing separator, lowercased on drive paths", input: { vaults: [A, shared("d")].map((v) => (v.id === "d" ? { ...v, path: "C:\\Docs\\Notes" } : v)), saved: "c:/docs/notes/", savedRepo: "a", repoId: "a" }, want: { ...shared("d"), path: "C:\\Docs\\Notes" } },
  ];
  for (const c of cases) it(c.name, () => expect(pickDocsSource(c.input)).toEqual(c.want));
});
