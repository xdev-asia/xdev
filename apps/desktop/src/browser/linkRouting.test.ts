import { describe, expect, it } from "vitest";
import { linkKeepsFocus, routeLink } from "./linkRouting";

describe("routeLink", () => {
  it.each([
    ["system", false, "https://x.dev/", "system"],
    ["system", true, "https://x.dev/", "pane"],
    ["pane", false, "https://x.dev/", "pane"],
    ["pane", true, "https://x.dev/", "system"],
    ["pane", false, "HTTP://localhost:5173/", "pane"],
    ["pane", false, "file:///etc/hosts", "system"],
    ["system", true, "mailto:a@x.dev", "system"],
    ["pane", false, "ftp://x.dev/", "system"],
  ] as const)("setting %s, Shift %s, %s goes to %s", (setting, shift, url, want) => {
    expect(routeLink(setting, shift, url)).toBe(want);
  });
});

describe("linkKeepsFocus", () => {
  it("moves the focus only for a plain click with the setting on the tab", () => {
    expect(linkKeepsFocus("pane", false)).toBe(false);
    expect(linkKeepsFocus("pane", true)).toBe(true);
    expect(linkKeepsFocus("system", true)).toBe(true);
    expect(linkKeepsFocus("system", false)).toBe(true);
  });
});
