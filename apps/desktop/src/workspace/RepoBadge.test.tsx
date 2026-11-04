import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RepoBadge } from "./RepoBadge";
import { REPO_COLORS, hexInk, isHexColor } from "./repoIdentity";

const html = (repo: Parameters<typeof RepoBadge>[0]["repo"], size?: "sm" | "md") => renderToStaticMarkup(RepoBadge({ repo, size }));

it("without an icon the badge shows the first letter of the short name, upper-cased", () => {
  const out = html({ shortName: "xdev", color: null, icon: null });
  expect(out).toContain(">X<");
  expect(out).toContain('data-color="none"');
  expect(html({ shortName: "web", color: null, icon: { kind: "letter" } })).toContain(">W<");
});

it("an emoji icon shows the emoji whole", () => {
  expect(html({ shortName: "xdev", color: "teal", icon: { kind: "emoji", value: "🚀" } })).toContain(">🚀<");
  expect(html({ shortName: "xdev", color: null, icon: { kind: "emoji", value: "🇻🇳" } })).toContain(">🇻🇳<");
});

it("a preset colour is a class over a design token, with no inline colour", () => {
  for (const name of REPO_COLORS) {
    const out = html({ shortName: "a", color: name, icon: null });
    expect(out).toContain(`data-color="${name}"`);
    expect(out).toContain(`ws-badge-tag-${name}`);
    expect(out).not.toContain("style=");
  }
});

it("a custom hex is an inline background with an ink tone chosen from its luminance", () => {
  const dark = html({ shortName: "a", color: "#112233", icon: null });
  expect(dark).toContain("background:#112233");
  expect(dark).toContain('data-ink="light"');
  const light = html({ shortName: "a", color: "#ffee88", icon: null });
  expect(light).toContain("background:#ffee88");
  expect(light).toContain('data-ink="dark"');
  // #rgb widens, upper case is kept as typed but compared as hex.
  expect(html({ shortName: "a", color: "#abc", icon: null })).toContain("background:#aabbcc");
});

it("a colour the app does not know falls back to the neutral badge", () => {
  const out = html({ shortName: "a", color: "chartreuse", icon: null });
  expect(out).toContain('data-color="none"');
  expect(out).not.toContain("style=");
});

it("size picks the class and the badge is hidden from assistive tech", () => {
  expect(html({ shortName: "a", color: null, icon: null })).toContain("ws-badge-sm");
  expect(html({ shortName: "a", color: null, icon: null }, "md")).toContain("ws-badge-md");
  expect(html({ shortName: "a", color: null, icon: null })).toContain('aria-hidden="true"');
});

it("hexInk picks a dark ink on light fills and a light one on dark fills", () => {
  expect(hexInk("#ffffff")).toBe("dark");
  expect(hexInk("#000000")).toBe("light");
  expect(hexInk("#ffd400")).toBe("dark");
  expect(hexInk("#3a3aa0")).toBe("light");
  expect(isHexColor("#abc") && isHexColor("#AABBCC")).toBe(true);
  expect(isHexColor("#abcd") || isHexColor("abc") || isHexColor("#ggg")).toBe(false);
});
