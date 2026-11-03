import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileCommands, QuickCommand } from "@/api";
import { translate } from "@/i18n";
import { buildSections, type Env } from "./model";
import { QuickCommandsMenu, quickCommandMenuItems } from "./QuickCommandsMenu";
import { selectCommands } from "./store";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const items: QuickCommand[] = [
  { id: "qc-g", label: "Git status", scope: { type: "global" }, action: { type: "terminal", command: "git status", appendEnter: true } },
  { id: "qc-r", label: "Review", scope: { type: "repo", repo: "/a" }, action: { type: "agent", profile: "ghost", prompt: "Review" } },
];
const file: FileCommands = { trusted: false, hash: "h", errors: [], commands: [{ label: "Lint", action: { type: "terminal", command: "pnpm lint", appendEnter: true } }] };
const env: Env = { hasTerminal: false, profiles: ["claude"] };
const sections = buildSections(selectCommands({ items, recent: ["qc-g"], files: {} }, "/a"), file, "", env);

it("draws sections, badges, the trust prompt and the reason a row cannot run", () => {
  const html = renderToStaticMarkup(<QuickCommandsMenu sections={sections} repoName="xdev" t={t} onTrust={() => {}} />);
  expect(html).toContain("Git status");
  expect(html).toContain(t("qcmd.notTrusted"));
  expect(html).toContain(t("qcmd.reviewTrust"));
  expect(html).toContain(t("qcmd.reason.unknownAgent"));
  expect(html).toContain(t("qcmd.reason.noTerminal"));
});

it("gives the same rows as context menu items, without Recent", () => {
  const chosen: string[] = [];
  const menu = quickCommandMenuItems(sections, (r) => chosen.push(r.label));
  expect(menu.map((m) => m.labelKey)).toEqual(["Review", "Lint", "Git status"]);
  expect(menu.every((m) => m.disabled)).toBe(true);
  menu[0].run?.();
  expect(chosen).toEqual(["Review"]);
});
