import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createMockApi, type Commit, type Freshness } from "../api";
import { parseFrontmatter, setVerified } from "../doc/frontmatter";
import { I18nProvider } from "../i18n";
import { DEMO_COMMITS, DEMO_SEED } from "../mockApi";
import { ago, FreshnessBanner, verifiedInDraft } from "./FreshnessBanner";

const NOW = 1_800_000_000;
const HEAD = "d2096ce7aa00000000000000000000000000beef";
const STORE = "docs/architecture/store.md";

function commit(id: string, message: string, hoursAgo: number): Commit {
  return { id, author: "Lan", time: NOW - hoursAgo * 3600, message };
}

function render(freshness: Freshness, draft = "", disabled = false): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <FreshnessBanner freshness={freshness} draft={draft} now={NOW} disabled={disabled} onMarkVerified={() => {}} />
    </I18nProvider>,
  );
}

function verifyButton(html: string): string {
  return /<button[^>]*class="freshness-verify"[^>]*>/.exec(html)?.[0] ?? "";
}

const stale: Freshness = {
  state: "stale",
  covers: ["crates/xdev-store/**"],
  verified: "3f2a9c1",
  head: HEAD,
  commits: [commit("d2096ce7aa", "store: busy timeout", 2), commit("5be90f4dbb", "store: ai writes", 30)],
  count: 3,
};

describe("FreshnessBanner", () => {
  it("banner_shows_stale_commits_and_count", () => {
    const html = render(stale);
    expect(html).toContain('class="banner banner-warn freshness-banner"');
    expect(html).toContain('data-state="stale"');
    expect(html).toContain('role="status"');
    expect(html).toContain("This doc may be out of date.");
    expect(html).toContain("3 new commits touched crates/xdev-store/** since it was verified at 3f2a9c1.");
    expect(html).toContain('<code class="history-id">d2096ce</code>');
    expect(html).toContain("store: busy timeout");
    expect(html).toContain("2 hours ago");
    expect(html).toContain("yesterday");
    expect(html).toContain("Showing 2 of 3 commits");
    expect(html).toContain("Still correct, mark verified");
  });

  it("hides when there is nothing to check or the doc is current", () => {
    expect(render({ ...stale, state: "none", commits: [], count: 0 })).toBe("");
    expect(render({ ...stale, state: "fresh", commits: [], count: 0 })).toBe("");
  });

  it("gives unverified and unknown docs their own wording", () => {
    const unverified = render({ ...stale, state: "unverified", verified: null, commits: [], count: 0 });
    expect(unverified).toContain("This doc has not been verified yet.");
    expect(unverified).toContain("Check it against crates/xdev-store/**, then mark it verified.");
    expect(unverified).not.toContain("freshness-commits");
    const noGit = render({ ...stale, state: "unknown", head: null, commits: [], count: 0 });
    expect(noGit).toContain("This folder is not tracked with git");
    const missing = render({ ...stale, state: "unknown", verified: "abcdef0123", commits: [], count: 0 });
    expect(missing).toContain("Commit abcdef0 from its verified line is not in this repository.");
  });

  it("shows the unlinked copy", () => {
    const html = render({ ...stale, state: "unlinked", covers: ["nobody:x/**"], head: null, commits: [], count: 0 });
    expect(html).toContain('data-state="unlinked"');
    expect(html).toContain("Some covered code is in a repo xDev does not know.");
    expect(html).toContain("Add the repo, or check the prefix in nobody:x/** against Settings → Repos.");
    expect(verifyButton(html)).toContain("disabled");
  });

  it("mark_verified_disabled_without_head", () => {
    const button = verifyButton(render({ ...stale, state: "unknown", head: null, commits: [], count: 0 }));
    expect(button).toContain("disabled");
    expect(button).toContain('title="Needs at least one git commit"');
    expect(verifyButton(render(stale))).not.toContain("disabled");
    expect(verifyButton(render(stale, "", true))).toContain("disabled");
  });

  it("mark_verified_sets_head_in_draft", async () => {
    const api = createMockApi(DEMO_SEED, { commits: DEMO_COMMITS });
    await api.openVault("/vault");
    const before = await api.docFreshness(STORE);
    expect(before.state).toBe("stale");
    const head = before.head ?? "";
    const draft = setVerified(await api.readDoc(STORE), head);
    expect(parseFrontmatter(draft).fm.verified).toBe(head);
    // Until it is saved the button has nothing left to do.
    expect(verifiedInDraft(draft, head)).toBe(true);
    expect(verifyButton(render(before, draft))).toContain("disabled");
    await api.writeDoc(STORE, draft);
    const after = await api.docFreshness(STORE);
    expect(after.state).toBe("fresh");
    expect(render(after, draft)).toBe("");
    expect((await api.staleDocs()).map((d) => d.path)).not.toContain(STORE);
  });

  it("formats times in the current locale", () => {
    expect(ago("en", NOW - 30, NOW)).toBe("now");
    expect(ago("en", NOW - 5 * 60, NOW)).toBe("5 minutes ago");
    expect(ago("en", NOW - 12 * 86400, NOW)).toBe("12 days ago");
    expect(ago("vi", NOW - 3 * 86400, NOW)).toBe("3 ngày trước");
  });
});
