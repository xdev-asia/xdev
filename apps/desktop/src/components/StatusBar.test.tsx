import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Quota } from "../api";
import type { Update } from "../shell/useUpdate";
import en from "../i18n/en.json";
import vi from "../i18n/vi.json";
import { I18nProvider } from "../i18n";
import { roomiest, StatusBar } from "./StatusBar";

function account(name: string, state: Quota["state"], ...use: (number | null)[]): Quota {
  const keys = ["five_hour", "seven_day"];
  return { name, state, reason: null, windows: use.map((utilization, i) => ({ key: keys[i], utilization, resetsAt: null })), asOf: null };
}

function render(props: { staleCount?: number; changeCount?: number | null; quota?: Quota[] | null; noVault?: boolean; update?: Update }): string {
  const vault = {
    name: "vault",
    docCount: 4,
    staleCount: props.staleCount ?? 0,
    changeCount: "changeCount" in props ? props.changeCount : 0,
  };
  return renderToStaticMarkup(
    <I18nProvider>
      <StatusBar vault={props.noVault ? null : vault} quota={props.quota === undefined ? null : props.quota} update={props.update} onOpen={() => {}} />
    </I18nProvider>,
  );
}

describe("roomiest", () => {
  it("picks the ok account with the lowest highest window", () => {
    const quota = [account("a", "ok", 10, 80), account("b", "ok", 50, 40), account("c", "reserve", 1), account("d", "full", 0), account("e", "unknown")];
    expect(roomiest(quota)?.name).toBe("b");
  });

  it("counts an account without numbers as 0 and keeps list order on ties", () => {
    expect(roomiest([account("a", "ok", 5), account("b", "ok", null), account("c", "ok")])?.name).toBe("b");
    expect(roomiest([account("a", "ok", 5), account("b", "ok", 5)])?.name).toBe("a");
  });

  it("returns null when no account is ok", () => {
    expect(roomiest([account("a", "reserve", 90), account("b", "unknown")])).toBeNull();
    expect(roomiest([])).toBeNull();
  });
});

describe("StatusBar", () => {
  it("shows vault name and doc count", () => {
    const markup = render({});
    expect(markup).toContain("vault");
    expect(markup).toContain("4 docs");
  });

  it("shows change count or not tracked", () => {
    expect(render({ changeCount: null })).toContain("Not tracked by git");
    expect(render({ changeCount: null })).not.toContain("pending");
    expect(render({ changeCount: 2 })).toContain("2 pending");
  });

  it("leaves the change item out while git status is unknown", () => {
    const markup = render({ changeCount: undefined });
    expect(markup).not.toContain("pending");
    expect(markup).not.toContain("Not tracked by git");
  });

  it("shows the stale item only when there are stale docs", () => {
    expect(render({ staleCount: 0 })).not.toContain("need review");
    expect(render({ staleCount: 2 })).toContain("2 need review");
  });

  it("shows the roomiest account or no room, and nothing without accounts", () => {
    expect(render({ quota: [account("claude-2", "ok", 50), account("claude-3", "ok", 6.4)] })).toContain("claude-3 · 5h 6%");
    expect(render({ quota: [account("claude-2", "ok")] })).toMatch(/>claude-2</);
    expect(render({ quota: [account("a", "reserve", 90)] })).toContain("No account with room");
    for (const quota of [[], null]) expect(render({ quota })).not.toContain("statusbar-end");
  });

  it("says no folder is open, and still shows the account", () => {
    const markup = render({ noVault: true, quota: [account("claude-2", "ok", 5)] });
    expect(markup).toContain("No folder open");
    expect(markup).not.toContain("docs");
    expect(markup).toContain("claude-2 · 5h 5%");
  });

  it("offers a restart for a downloaded update, and shows progress and failure", () => {
    const update: Update = { version: "0.3.0", notes: null, status: "ready" };
    expect(render({})).not.toContain("Update");
    expect(render({ update })).toMatch(/<button[^>]*>Restart to update to 0.3.0</);
    expect(render({ update: { ...update, status: "restarting" } })).toMatch(/<span class="statusbar-end">Updating…</);
    expect(render({ update: { ...update, status: "failed" } })).toContain("Update failed, try again");
  });

  it("has every apps and status key in vi", () => {
    const keys = Object.keys(en).filter((key) => key.startsWith("apps.") || key.startsWith("status."));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(vi).toHaveProperty([key]);
  });
});
