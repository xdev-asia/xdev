import { describe, expect, it } from "vitest";
import type { HostSettings } from "@/api";
import { badEnvRows, changedKeys, daysOk, fromForm, patch, toForm } from "./hostModel";

const empty: HostSettings = { label: null, shell: null, env: [], history: { enabled: null, claudeHome: null, codexHome: null, days: null } };
const full: HostSettings = {
  label: "Build box",
  shell: "/bin/zsh",
  env: [{ name: "FOO", value: "1" }],
  history: { enabled: false, claudeHome: "~/.c", codexHome: "/opt/x", days: 30 },
};

describe("host form model", () => {
  it("round-trips stored settings", () => {
    expect(fromForm(toForm(empty))).toEqual(empty);
    expect(fromForm(toForm(full))).toEqual(full);
  });

  it("a blank field is the default, and clears exactly that key", () => {
    const f = toForm(full);
    f.shell = "  ";
    const next = fromForm(f);
    expect(next).toEqual({ ...full, shell: null });
    expect(changedKeys(full, next)).toEqual(["shell"]);
  });

  it("an unparsable day count is the default", () => {
    const f = toForm(full);
    f.days = "abc";
    expect(fromForm(f).history.days).toBeNull();
    expect(daysOk("abc")).toBe(false);
    expect(daysOk("0")).toBe(false);
    expect(daysOk("3651")).toBe(false);
    expect(daysOk("")).toBe(true);
    expect(daysOk("90")).toBe(true);
  });

  it("flags env names that are not variable names and drops blank rows", () => {
    expect(badEnvRows([{ name: "OK_1", value: "" }, { name: "1x", value: "" }, { name: "a-b", value: "" }, { name: "", value: "z" }])).toEqual([1, 2]);
    const f = toForm(empty);
    f.env = [{ name: " ", value: "z" }, { name: "A", value: "b" }];
    expect(fromForm(f).env).toEqual([{ name: "A", value: "b" }]);
  });

  it("a patch carries only the changed keys", () => {
    const next = { ...full, label: "Other" };
    expect(patch(empty, next, ["label"])).toEqual({ ...empty, label: "Other" });
    expect(patch(full, empty, changedKeys(full, empty))).toEqual(empty);
  });
});
