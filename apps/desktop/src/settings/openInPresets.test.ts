import { expect, it } from "vitest";
import { isPresetAdded, OPEN_IN_PRESETS, presetEntry } from "./openInPresets";

const [vscode, cursor] = OPEN_IN_PRESETS;

it("lists the four editors by program", () => {
  expect(OPEN_IN_PRESETS.map((p) => p.command)).toEqual(["code", "cursor", "zed", "windsurf"]);
});

it("knows a preset by its program, whatever the entry is named", () => {
  const apps = [{ id: "app-1", label: "My code", command: "code", args: ["--reuse-window"] }];
  expect(isPresetAdded(apps, vscode)).toBe(true);
  expect(isPresetAdded(apps, cursor)).toBe(false);
  expect(isPresetAdded([], vscode)).toBe(false);
});

it("builds an entry with the preset's own id when it is free", () => {
  expect(presetEntry([], cursor)).toEqual({ id: "cursor", label: "Cursor", command: "cursor", args: [] });
});

it("takes the next app-N id when the preset's id is used", () => {
  const apps = [{ id: "cursor", label: "Other", command: "other", args: [] }];
  expect(presetEntry(apps, cursor).id).toBe("app-1");
});

it("does not share the args array with the preset", () => {
  expect(presetEntry([], cursor).args).not.toBe(cursor.args);
});
