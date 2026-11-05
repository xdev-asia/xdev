import { describe, expect, it } from "vitest";
import { envChanged, isBlank, keyProblem, rowsFrom, rowsValid, secretPlan, toPatch, type EnvRow } from "./envRows";

const row = (id: number, key: string, value = "", secret = false, stored = false): EnvRow => ({ id, key, value, secret, stored });

describe("keyProblem", () => {
  it("accepts shell names and refuses the rest", () => {
    for (const ok of ["A", "_x", "Path_2"]) expect(keyProblem(ok, [], 0)).toBeUndefined();
    for (const bad of ["", " ", "1A", "A-B", "A B", "A=B", "é"]) expect(keyProblem(bad, [], 0)).toBe("invalid");
  });
  it("refuses the app's own prefix and a repeated key", () => {
    expect(keyProblem("XDEV_ROOT_PATH", [], 0)).toBe("reserved");
    expect(keyProblem("A", [row(1, "A"), row(2, "A")], 2)).toBe("duplicate");
    expect(keyProblem("A", [row(1, "A")], 1)).toBeUndefined();
  });
});

describe("rows", () => {
  it("ignores blank rows and flags the others", () => {
    expect(isBlank(row(1, " "))).toBe(true);
    expect(isBlank(row(1, "", "x"))).toBe(false);
    expect(rowsValid([row(1, ""), row(2, "A", "1")])).toBe(true);
    expect(rowsValid([row(1, "", "x")])).toBe(false);
    expect(rowsValid([row(1, "A"), row(2, "A")])).toBe(false);
  });
  it("saves empty plain values, trims keys and never carries a secret value", () => {
    expect(toPatch([row(1, " A ", ""), row(2, "T", "hunter2", true), row(3, "")])).toEqual([
      { key: "A", value: "", secret: false },
      { key: "T", value: "", secret: true },
    ]);
  });
  it("starts from the saved rows and marks the secrets the keychain has", () => {
    const rows = rowsFrom(
      [
        { key: "A", value: "1", secret: false },
        { key: "T", value: "", secret: true },
        { key: "U", value: "", secret: true },
      ],
      ["T"],
    );
    expect(rows.map((r) => [r.key, r.value, r.stored])).toEqual([
      ["A", "1", false],
      ["T", "", true],
      ["U", "", false],
    ]);
    expect(rowsFrom(undefined, [])).toEqual([]);
  });
});

describe("secretPlan", () => {
  const before = [
    { key: "OLD", value: "", secret: true },
    { key: "KEEP", value: "", secret: true },
    { key: "TURNED", value: "", secret: true },
  ];
  it("writes typed secrets, clears gone or plain ones and leaves an untouched secret alone", () => {
    const after = [row(1, "KEEP", "", true, true), row(2, "NEW", "s3", true), row(3, "TURNED", "plain", false)];
    expect(secretPlan(before, after)).toEqual({ set: [{ key: "NEW", value: "s3" }], clear: ["OLD", "TURNED"] });
  });
  it("does nothing for no rows", () => {
    expect(secretPlan(undefined, [])).toEqual({ set: [], clear: [] });
  });
});

describe("envChanged", () => {
  it("compares with what is saved and counts a typed secret", () => {
    const saved = [{ key: "A", value: "1", secret: false }];
    expect(envChanged(saved, [row(1, "A", "1")])).toBe(false);
    expect(envChanged(saved, [row(1, "A", "2")])).toBe(true);
    expect(envChanged(undefined, [row(1, "T", "x", true)])).toBe(true);
    expect(envChanged(undefined, [row(1, "")])).toBe(false);
  });
});
