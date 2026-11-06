import { expect, it } from "vitest";
import type { TargetsView } from "@/api";
import { cdLine, deployEntries, isEmpty, needsTrust, serverEntry, shellQuote } from "./targetsModel";

const view = (over: Partial<TargetsView> = {}): TargetsView => ({
  deploy: [
    { name: "Vercel preview", run: "vercel deploy", confirm: false, source: "detected" },
    { name: "Staging", run: "make stage", confirm: false, source: "repo" },
  ],
  vps: { host: "prod-1", cwd: "/srv/app", notes: null },
  trusted: true,
  hash: "h",
  text: null,
  error: null,
  vpsHostKnown: true,
  ...over,
});

it("lists presets in order and disables only repo presets while untrusted", () => {
  expect(deployEntries(view()).map((e) => e.disabled)).toEqual([null, null]);
  expect(deployEntries(view({ trusted: false })).map((e) => e.disabled)).toEqual([null, "untrusted"]);
});

it("asks for trust only when there is something to trust", () => {
  expect(needsTrust(view({ trusted: false }))).toBe(true);
  expect(needsTrust(view({ trusted: false, hash: "" }))).toBe(false);
  expect(needsTrust(view())).toBe(false);
});

it("the server entry follows trust and is absent without a vps", () => {
  expect(serverEntry(view({ vps: null }))).toBeNull();
  expect(serverEntry(view())?.disabled).toBeNull();
  expect(serverEntry(view({ trusted: false }))?.disabled).toBe("untrusted");
});

it("is empty without presets and vps", () => {
  expect(isEmpty(view({ deploy: [], vps: null }))).toBe(true);
  expect(isEmpty(view())).toBe(false);
});

it("quotes a folder for the shell", () => {
  expect(shellQuote("/srv/app")).toBe("/srv/app");
  expect(shellQuote("/srv/my app")).toBe("'/srv/my app'");
  expect(shellQuote("it's")).toBe("'it'\\''s'");
  expect(cdLine({ host: "h", cwd: "/srv/my app", notes: null })).toBe("cd '/srv/my app'");
  expect(cdLine({ host: "h", cwd: null, notes: null })).toBeNull();
});
