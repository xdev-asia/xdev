import { describe, expect, it } from "vitest";
import type { XdevIdState } from "@xdev/bindings";
import { createMockApi, toApiError } from "./api";

const LINK = (state: string) => `xdev://auth/callback?code=abc&state=${state}`;

describe("mock xDev ID", () => {
  it("mock_xdev_id_walks_sign_in_paste_and_sign_out", async () => {
    const api = createMockApi({});
    expect(await api.xdevIdState()).toEqual({ state: "signedOut", notice: null });
    const waiting = await api.xdevIdSignIn();
    expect(waiting).toMatchObject({ state: "signingIn" });
    expect((waiting as { link: string }).link).toContain("https://id.xdev.asia/desktop?");
    const done = await api.xdevIdPaste(`  ${LINK("demo")}\n`);
    expect(done).toEqual({ state: "signedIn", user: { name: "Demo User", email: "demo@example.com", avatar: null } });
    expect(await api.xdevIdRefresh()).toEqual(done);
    expect(await api.xdevIdSignOut()).toEqual({ state: "signedOut", notice: null });
  });

  it("mock_xdev_id_rejects_a_bad_link_a_wrong_state_and_no_attempt", async () => {
    const api = createMockApi({});
    await expect(api.xdevIdPaste(LINK("demo"))).rejects.toMatchObject({ code: "account_state" });
    await api.xdevIdSignIn();
    await expect(api.xdevIdPaste("https://example.com")).rejects.toMatchObject({ code: "account_link" });
    await expect(api.xdevIdPaste("xdev://auth/callback?state=demo")).rejects.toMatchObject({ code: "account_link" });
    await expect(api.xdevIdPaste(LINK("other"))).rejects.toMatchObject({ code: "account_state" });
    // A rejected paste keeps the attempt.
    expect(await api.xdevIdState()).toMatchObject({ state: "signingIn" });
  });

  it("mock_xdev_id_cancel_returns_to_signed_out", async () => {
    const api = createMockApi({});
    await api.xdevIdSignIn();
    expect(await api.xdevIdCancel()).toEqual({ state: "signedOut", notice: null });
  });

  it("mock_xdev_id_expiry_and_deep_link_hooks", async () => {
    const api = createMockApi({}, { xdevId: "signedIn" });
    expect(await api.xdevIdState()).toMatchObject({ state: "signedIn" });
    api.__xdevIdExpire();
    expect(await api.xdevIdState()).toEqual({ state: "signedOut", notice: "account_expired" });
    api.__xdevIdDeepLink();
    expect(await api.xdevIdState()).toMatchObject({ state: "signedOut" });
    await api.xdevIdSignIn();
    api.__xdevIdDeepLink();
    expect(await api.xdevIdState()).toMatchObject({ state: "signedIn" });
  });

  it("mock_xdev_id_listeners_fire_on_every_change_until_removed", async () => {
    const api = createMockApi({});
    const seen: XdevIdState["state"][] = [];
    const stop = await api.onXdevIdChanged((s) => seen.push(s.state));
    await api.xdevIdSignIn();
    await api.xdevIdPaste(LINK("demo"));
    api.__xdevIdExpire();
    stop();
    await api.xdevIdSignIn();
    expect(seen).toEqual(["signingIn", "signedIn", "signedOut"]);
  });

  it("mock_xdev_id_manage_resolves", async () => {
    const api = createMockApi({});
    await api.xdevIdManage();
    expect(api.__xdevIdManages()).toBe(1);
  });

  it("account_error_codes_survive_toApiError", () => {
    for (const code of ["account_keychain", "account_unavailable", "account_link", "account_state", "account_code", "account_expired", "account_timeout"]) {
      expect(toApiError({ code })).toEqual({ code });
    }
  });
});
