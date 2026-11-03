import { describe, expect, it } from "vitest";
import { checkPrompt, namedPaths } from "./promptCheck";

// 40 words: a goal, a test command, one named file.
const CLEAR =
  "Fix the login redirect bug in `src/auth/login.ts` so that users land on the dashboard after sign in. " +
  "Done when `pnpm test login` passes and the redirect shows the dashboard page for every user role. " +
  "Keep the change small and focused.";

const EXISTS = { "src/auth/login.ts": true };

const failed = (text: string, existing: Record<string, boolean> = {}) =>
  checkPrompt(text, existing)
    .checks.filter((c) => !c.pass)
    .map((c) => c.id);

describe("checkPrompt", () => {
  it("the fixture holds 40 words", () => {
    expect(CLEAR.split(/\s+/).length).toBe(40);
  });

  it("a clear prompt scores 100", () => {
    const r = checkPrompt(CLEAR, EXISTS);
    expect(failed(CLEAR, EXISTS)).toEqual([]);
    expect(r.score).toBe(100);
  });

  it("returns the six checks in order with their weights and hint keys", () => {
    const r = checkPrompt(CLEAR, EXISTS);
    expect(r.checks.map((c) => [c.id, c.weight, c.hintKey])).toEqual([
      ["goal", 25, "kit.prompt.hint.goal"],
      ["accept", 25, "kit.prompt.hint.accept"],
      ["files", 15, "kit.prompt.hint.files"],
      ["single", 15, "kit.prompt.hint.single"],
      ["vague", 10, "kit.prompt.hint.vague"],
      ["length", 10, "kit.prompt.hint.length"],
    ]);
  });

  it('"fix it" fails vague and goal', () => {
    const f = failed("fix it");
    expect(f).toContain("vague");
    expect(f).toContain("goal");
  });

  it("a missing named file fails files only", () => {
    const text = `${CLEAR} See \`src/auth/missing.ts\`.`;
    expect(failed(text, EXISTS)).toEqual(["files"]);
    expect(checkPrompt(text, EXISTS).score).toBe(85);
  });

  it("a path flagged false in existing fails files", () => {
    expect(failed(CLEAR, { "src/auth/login.ts": false })).toEqual(["files"]);
  });

  it("no named file passes files", () => {
    const text =
      "Rename the settings panel title to Preferences across the whole app. " +
      "Expected: `pnpm test settings` passes.";
    expect(namedPaths(text)).toEqual([]);
    expect(failed(text)).toEqual([]);
  });

  it("two tasks joined fails single", () => {
    const text =
      "Fix the login redirect bug so that users land on the dashboard and also add a logout button to the header. " +
      "Expected: `pnpm test` passes.";
    expect(failed(text)).toEqual(["single"]);
  });

  it("a Vietnamese joiner fails single", () => {
    const text =
      "Sửa lỗi chuyển hướng đăng nhập về trang chủ và cả thêm nút đăng xuất ở thanh trên cùng. " +
      "Kết quả: `pnpm test` chạy xong không lỗi.";
    expect(failed(text)).toEqual(["single"]);
  });

  it("two numbered lists fail single, one list passes", () => {
    const one = `${CLEAR}\n1. first step\n2. second step`;
    const two = `${CLEAR}\n1. first step\n2. second step\nThen later:\n1. other step\n2. last step`;
    expect(failed(one, EXISTS)).toEqual([]);
    expect(failed(two, EXISTS)).toEqual(["single"]);
  });

  it("an unfinished vague phrase fails vague but one with an object passes", () => {
    const base = "Add a retry to the upload client in the sync module. Expected: `pnpm test sync` passes. ";
    expect(failed(`${base}Then make it better.`)).toEqual(["vague"]);
    expect(failed(`${base}Then make it better for slow networks.`)).toEqual([]);
  });

  it("reads Vietnamese with and without diacritics", () => {
    const withMarks = "Thêm nút xoá vào trang danh sách. Kiểm tra bằng `pnpm test list` cho kết quả đạt.";
    const without = "Them nut xoa vao trang danh sach. Kiem tra bang `pnpm test list` cho ket qua dat.";
    expect(failed(withMarks)).toEqual([]);
    expect(failed(without)).toEqual([]);
    expect(failed("Sửa nó")).toEqual(expect.arrayContaining(["vague", "goal"]));
    expect(failed("Sua no")).toEqual(expect.arrayContaining(["vague", "goal"]));
  });

  it("matches a decomposed (NFD) Vietnamese text the same way", () => {
    const nfd = "Thêm nút xoá vào trang danh sách. Xong khi danh sách hiện nút xoá cho từng dòng và ghi lại kết quả vào nhật ký.".normalize("NFD");
    expect(failed(nfd)).toEqual([]);
  });

  it("accept passes on a test word, a done phrase, or backticks, and fails otherwise", () => {
    const base = "Rename the settings panel title to Preferences across the whole app today please and keep it short";
    expect(failed(`${base}.`)).toEqual(["accept"]);
    expect(failed(`${base}, expected to read Preferences.`)).toEqual([]);
    expect(failed(`${base}. Done when the title reads Preferences.`)).toEqual([]);
    expect(failed(`${base}. Run \`pnpm build\`.`)).toEqual([]);
  });

  it("length needs 15 to 1500 words", () => {
    const tail = " Expected: `pnpm test` passes.";
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    const mk = (n: number) => `Add ${words(n - 5)}${tail}`; // tail holds 4 words, "Add" 1
    expect(failed(mk(14))).toEqual(["length"]);
    expect(failed(mk(15))).toEqual([]);
    expect(failed(mk(1500))).toEqual([]);
    expect(failed(mk(1501))).toEqual(["length"]);
  });

  it("tokens use bytes / 4 rounded up", () => {
    // "Xin chào" is 8 characters but 9 UTF-8 bytes (à takes 2): ceil(9 / 4) = 3, not 2.
    expect(checkPrompt("Xin chào", {}).tokens).toBe(3);
    expect(checkPrompt("abcd", {}).tokens).toBe(1);
    expect(checkPrompt("abcde", {}).tokens).toBe(2);
    expect(checkPrompt("", {}).tokens).toBe(0);
  });

  it("score sums the weights of the passing checks", () => {
    const r = checkPrompt("fix it", {});
    const sum = r.checks.filter((c) => c.pass).reduce((n, c) => n + c.weight, 0);
    expect(r.score).toBe(sum);
  });
});

describe("namedPaths", () => {
  it("finds backticked tokens and slash tokens with an extension", () => {
    const text = "Edit `config.json` and src/app/main.tsx, then see apps/desktop/README.md.";
    expect(namedPaths(text)).toEqual(["config.json", "src/app/main.tsx", "apps/desktop/README.md"]);
  });

  it("skips commands, bare words and slash tokens without an extension", () => {
    expect(namedPaths("Run `pnpm test` and pick either/or, version 1.5 of the app.")).toEqual([]);
  });

  it("keeps the exact string and lists each path once", () => {
    expect(namedPaths("Open src/A.ts, then `src/A.ts` again, and src/a.ts.")).toEqual(["src/A.ts", "src/a.ts"]);
  });
});
