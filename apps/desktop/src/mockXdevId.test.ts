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
    // Rust checks the link shape before the attempt: junk is a link error even with no attempt.
    await expect(api.xdevIdPaste("https://example.com")).rejects.toMatchObject({ code: "account_link" });
    await expect(api.xdevIdPaste(LINK("demo"))).rejects.toMatchObject({ code: "account_state" });
    await api.xdevIdSignIn();
    await expect(api.xdevIdPaste("https://example.com")).rejects.toMatchObject({ code: "account_link" });
    await expect(api.xdevIdPaste("xdev://auth/callback?state=demo")).rejects.toMatchObject({ code: "account_link" });
    await expect(api.xdevIdPaste(LINK("other"))).rejects.toMatchObject({ code: "account_state" });
    // A rejected paste keeps the attempt.
    expect(await api.xdevIdState()).toMatchObject({ state: "signingIn" });
  });

  it("mock_xdev_id_reopen_needs_a_running_attempt_and_starts_no_new_one", async () => {
    const api = createMockApi({});
    await expect(api.xdevIdReopen()).rejects.toMatchObject({ code: "account_state" });
    const waiting = await api.xdevIdSignIn();
    await api.xdevIdReopen();
    await api.xdevIdReopen();
    expect(api.__xdevIdReopens()).toBe(2);
    expect(await api.xdevIdState()).toEqual(waiting);
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
  it("mock_xdev_id_server_validates_saves_and_signs_out_on_a_change", async () => {
    const api = createMockApi({}, { xdevId: "signedIn" });
    expect(await api.xdevIdServer()).toEqual({ origin: "https://id.xdev.asia", source: "default", setting: "", invalid: false });
    for (const bad of ["http://id.corp.test", "https://id.corp.test/p", "https://u@id.corp.test", "https://id.corp.test?x=1", "nope"]) {
      await expect(api.xdevIdServerSet(bad)).rejects.toMatchObject({ code: "account_server" });
    }
    expect(await api.xdevIdState()).toMatchObject({ state: "signedIn" });
    // The same server keeps the session.
    await api.xdevIdServerSet("https://id.xdev.asia/");
    expect(await api.xdevIdState()).toMatchObject({ state: "signedIn" });
    const heard: XdevIdState[] = [];
    await api.onXdevIdChanged((s) => heard.push(s));
    expect(await api.xdevIdServerSet(" https://id.corp.test/ ")).toEqual({ origin: "https://id.corp.test", source: "setting", setting: "https://id.corp.test", invalid: false });
    expect(heard).toEqual([{ state: "signedOut", notice: null }]);
    await api.xdevIdServerSet("http://localhost:8080");
    expect((await api.xdevIdServer()).origin).toBe("http://localhost:8080");
    expect(await api.xdevIdServerSet("")).toMatchObject({ origin: "https://id.xdev.asia", source: "default", setting: "" });
  });
});
