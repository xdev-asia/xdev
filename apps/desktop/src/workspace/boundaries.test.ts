import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(src, rel), "utf8");

// Every boundary id of the plan and the file that must carry it: a cheap guard against a lost wrap.
const WRAPS: [string, string[]][] = [
  ["workspace/WorkspaceShell.tsx", ["sidebar.worktrees", "sidebar.sessions", "workspace.tabs", "panel.${name}".replace("${name}", "files"), "panel.search", "panel.changes", "panel.checks", "panel.issues", "page.docs"]],
  ["workspace/WorktreeTabs.tsx", ["terminal.", "editor.file", 'id="review"']],
  ["settings/SettingsView.tsx", ["page.settings"]],
  ["components/ErrorBoundary.tsx", ["app.root"]],
];

describe("surface boundaries", () => {
  for (const [file, ids] of WRAPS) {
    it(`${file} keeps its boundaries`, () => {
      const text = read(file);
      for (const id of ids) expect(text, id).toContain(id);
    });
  }
});

describe("startup banner", () => {
  it("sits at the top of ws-stage, before the body", () => {
    const text = read("workspace/WorkspaceShell.tsx");
    const stage = text.indexOf('className="ws-stage"');
    const banner = text.indexOf("<StartupBanner");
    const body = text.indexOf('className="ws-stage-body"');
    expect(stage).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(stage);
    expect(body).toBeGreaterThan(banner);
    expect(text.match(/<StartupBanner/g)).toHaveLength(1);
  });
});
