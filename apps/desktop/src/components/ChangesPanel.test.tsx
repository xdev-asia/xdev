import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createMockApi, type Change } from "@/api";
import type { Changes } from "@/changes/useChanges";
import { I18nProvider } from "@/i18n";
import { DEMO_AI_EDIT, DEMO_COMMITS, DEMO_SEED } from "@/mockApi";
import { ChangesPanel, ChangeView } from "./ChangesPanel";

function review(changes: Change[]): Changes {
  const done = async () => true;
  return {
    status: "ok",
    changes,
    busy: false,
    revision: 1,
    refresh: () => {},
    init: async () => {},
    approve: done,
    reject: done,
    clearError: () => {},
  };
}

async function proposed(): Promise<{ api: ReturnType<typeof createMockApi>; changes: Change[] }> {
  const api = createMockApi(DEMO_SEED, { commits: DEMO_COMMITS });
  await api.openVault("/vault");
  api.__propose(DEMO_AI_EDIT.path, DEMO_AI_EDIT.content, DEMO_AI_EDIT.note);
  return { api, changes: await api.listChanges() };
}

describe("ChangesPanel", () => {
  it("ai_change_shows_badge_and_note", async () => {
    const { changes } = await proposed();
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ChangesPanel
          review={review(changes)}
          selected={null}
          message=""
          onMessage={() => {}}
          onSelect={() => {}}
          onApprove={() => {}}
          onReject={() => {}}
        />
      </I18nProvider>,
    );
    expect(html).toContain('<span class="badge" data-origin="ai">Proposed by AI</span>');
    expect(html).toContain(`<span class="change-note change-note-list">Agent&#x27;s note: ${DEMO_AI_EDIT.note}</span>`);
  });

  it("other origins carry no note", () => {
    const outside: Change = { path: "README.md", kind: "modified", origin: "outside", note: null, hash: null };
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ChangesPanel
          review={review([outside])}
          selected={null}
          message=""
          onMessage={() => {}}
          onSelect={() => {}}
          onApprove={() => {}}
          onReject={() => {}}
        />
      </I18nProvider>,
    );
    expect(html).toContain('data-origin="outside"');
    expect(html).not.toContain("change-note");
  });

  it("the diff view shows the agent's note above the diff", async () => {
    const { api, changes } = await proposed();
    const change = changes.find((c) => c.origin === "ai");
    expect(change).toBeDefined();
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ChangeView
          api={api}
          change={change as Change}
          revision={1}
          busy={false}
          onApprove={() => {}}
          onReject={() => {}}
          onOpenDoc={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    );
    expect(html).toContain('data-origin="ai"');
    expect(html).toContain('<span class="change-note diff-note">');
  });
});
