import { expect, it, vi } from "vitest";
import { Button, IconButton } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { mount, nodes, textOf, type Node } from "@/kit/testHooks";
import type { ShareCardData } from "@/kit/shareCard";
import { UsageShare } from "./UsageShare";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const act = (all: Node[], name: string) => all.find((n) => n.props["data-act"] === name);

const data: ShareCardData = {
  provider: "claude",
  range: "30",
  untilDay: "2026-11-04",
  cost: { nanos: 12_340_000_000, unpriced: false, priced: true },
  tokens: 1_234_567,
  topModel: "claude-opus-4-5",
  sessions: 12,
  days: [["2026-11-04", { input: 100, output: 0, cache_read: 0, cache_write: 0 }]],
};
const colors = () => ({
  "--x-color-bg": "tok-bg",
  "--x-color-surface": "tok-surface",
  "--x-color-line": "tok-line",
  "--x-color-ink": "tok-ink",
  "--x-color-muted": "tok-muted",
  "--x-color-accent": "tok-accent",
});
const PNG = new Uint8Array([1, 2, 3]);

function setup(over: { copy?: () => Promise<void>; post?: () => Promise<void>; toPng?: () => Promise<Uint8Array> } = {}) {
  const api = {
    usageShareCopyImage: vi.fn(over.copy ?? (async () => {})),
    usageSharePost: vi.fn<(text: string) => Promise<void>>(over.post ?? (async () => {})),
  };
  const toPng = vi.fn<(svg: string, width: number, height: number) => Promise<Uint8Array>>(over.toPng ?? (async () => PNG));
  const m = mount(UsageShare, () => ({ api, data, toPng, colors }));
  return { api, toPng, m };
}

async function opened(over?: Parameters<typeof setup>[0]) {
  const s = setup(over);
  await s.m.settle();
  act(s.m.all(), "share")!.props.onClick();
  await s.m.settle();
  return s;
}

it("shows only the trigger until it is clicked, with a label for screen readers", async () => {
  const { m } = setup();
  await m.settle();
  const trigger = m.all().find((n) => n.type === IconButton)!;
  expect(trigger.props.icon).toBe("download");
  expect(trigger.props.label).toBe(en("usage.share.tooltip"));
  expect(m.all().some((n) => n.type === "dialog")).toBe(false);
});

it("opens a dialog with the card and one primary button, Copy image", async () => {
  const { m } = await opened();
  const all = m.all();
  const dialog = all.find((n) => n.type === "dialog")!;
  expect(dialog.props.className).toContain("ws-dialog");
  expect(dialog.props["aria-modal"]).toBe("true");
  const card = all.find((n) => n.props["data-share-card"] !== undefined)!;
  const html = (card.props.dangerouslySetInnerHTML as { __html: string }).__html;
  expect(html).toContain('viewBox="0 0 480 270"');
  expect(html).toContain("tok-accent");
  const buttons = all.filter((n) => n.type === Button);
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.props["data-act"]).toBe("share-copy");
  expect(buttons[0]!.props.type).toBe("button");
  expect(textOf(buttons[0]!)).toBe(en("usage.share.copy"));
  for (const b of all.filter((n) => n.type === "button")) expect(b.props.type).toBe("button");
});

it("copies the PNG of the card, says Copied, and goes back to Copy image after 2 s", async () => {
  const { m, api, toPng } = await opened();
  act(m.all(), "share-copy")!.props.onClick();
  await m.settle();
  expect(toPng).toHaveBeenCalledTimes(1);
  expect(toPng.mock.calls[0]![1]).toBe(480);
  expect(api.usageShareCopyImage).toHaveBeenCalledWith(PNG);
  expect(textOf(act(m.all(), "share-copy")!)).toBe(en("usage.share.copied"));
  await new Promise((r) => setTimeout(r, 2200));
  await m.settle();
  expect(textOf(act(m.all(), "share-copy")!)).toBe(en("usage.share.copy"));
}, 10_000);

it("shows the clipboard error when the copy fails, and when the card cannot be drawn", async () => {
  const failed = await opened({ copy: () => Promise.reject({ code: "share_clipboard", message: "" }) });
  act(failed.m.all(), "share-copy")!.props.onClick();
  await failed.m.settle();
  const err = failed.m.all().find((n) => n.props["data-share-error"] !== undefined)!;
  expect(textOf(err)).toBe(en("error.share_clipboard"));
  expect(textOf(act(failed.m.all(), "share-copy")!)).toBe(en("usage.share.copy"));

  const undrawn = await opened({ toPng: () => Promise.reject(new Error("no canvas")) });
  act(undrawn.m.all(), "share-copy")!.props.onClick();
  await undrawn.m.settle();
  expect(textOf(undrawn.m.all().find((n) => n.props["data-share-error"] !== undefined)!)).toBe(en("error.share_clipboard"));
  expect(undrawn.api.usageShareCopyImage).not.toHaveBeenCalled();
});

it("opens a post with the share text for Share on X", async () => {
  const { m, api } = await opened();
  act(m.all(), "share-post")!.props.onClick();
  await m.settle();
  const text = api.usageSharePost.mock.calls[0]![0] as string;
  expect(text).toContain("Claude");
  expect(text).toContain("1,234,567 tokens");
  expect(text).toContain("$12.34");
});

it("shows the message of a post that could not open", async () => {
  const { m } = await opened({ post: () => Promise.reject({ code: "share_open", message: "" }) });
  act(m.all(), "share-post")!.props.onClick();
  await m.settle();
  expect(textOf(m.all().find((n) => n.props["data-share-error"] !== undefined)!)).toBe(en("error.share_open"));
});

it("closes on Escape and on Close", async () => {
  const { m } = await opened();
  const prevented = vi.fn();
  m.all().find((n) => n.type === "dialog")!.props.onCancel({ preventDefault: prevented });
  await m.settle();
  expect(prevented).toHaveBeenCalled();
  expect(m.all().some((n) => n.type === "dialog")).toBe(false);

  act(m.all(), "share")!.props.onClick();
  await m.settle();
  act(m.all(), "share-close")!.props.onClick();
  await m.settle();
  expect(m.all().some((n) => n.type === "dialog")).toBe(false);
});

it("scales the card to the dialog, so it fits at 360 px", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../styles/usageStats.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.usage-share-card svg\s*\{[^}]*width:\s*100%[^}]*height:\s*auto/);
  expect(css).toMatch(/\.usage-share\s*\{[^}]*max-width:\s*min\(520px,\s*calc\(100vw/);
  expect(nodes).toBeTypeOf("function");
});
