import type { XdevIdServer, XdevIdState } from "@xdev/bindings";
import type { Api } from "./api";

type XdevIdApi = Pick<
  Api,
  "xdevIdState" | "xdevIdSignIn" | "xdevIdPaste" | "xdevIdCancel" | "xdevIdSignOut" | "xdevIdRefresh" | "xdevIdReopen" | "xdevIdManage" | "xdevIdServer" | "onXdevIdChanged"
>;

export type MockXdevId = XdevIdApi & {
  // The service answers 401 on the next check: signed out with the `account_expired` notice.
  __xdevIdExpire(): void;
  // The browser hands the sign-in link back to the app (a deep link); a pending attempt completes.
  __xdevIdDeepLink(): void;
  // How often `xdevIdManage` ran.
  __xdevIdManages(): number;
  // How often `xdevIdReopen` ran.
  __xdevIdReopens(): number;
  // Settings → Cloud saved a different xDev server (`null`: the default).
  __xdevIdServerChanged(serverUrl: string | null): void;
};

export const MOCK_XDEV_ID_LINK = "https://id.xdev.asia/desktop?challenge=demo&state=demo&device=Demo";
const DEMO_USER = { name: "Demo User", email: "demo@example.com", avatar: null };
const CALLBACK = "xdev://auth/callback?";
const DEFAULT_SERVER = "https://id.xdev.asia";

/** The xDev ID account in memory: no network, no timers; every change calls the listeners synchronously. */
export function createMockXdevId(initial: "signedOut" | "signedIn" = "signedOut"): MockXdevId {
  let state: XdevIdState = initial === "signedIn" ? { state: "signedIn", user: DEMO_USER } : { state: "signedOut", notice: null };
  let manages = 0;
  let reopens = 0;
  let server: XdevIdServer = { origin: DEFAULT_SERVER, source: "default", setting: "", invalid: false };
  const listeners = new Set<(s: XdevIdState) => void>();
  const set = (next: XdevIdState): XdevIdState => {
    state = next;
    for (const l of [...listeners]) l(state);
    return state;
  };
  const signedIn = (): XdevIdState => ({ state: "signedIn", user: DEMO_USER });
  const signedOut = (): XdevIdState => ({ state: "signedOut", notice: null });
  return {
    async xdevIdState() {
      return state;
    },
    async xdevIdSignIn() {
      return set({ state: "signingIn", link: MOCK_XDEV_ID_LINK });
    },
    async xdevIdPaste(link) {
      const text = link.trim();
      if (!text.startsWith(CALLBACK) || !/[?&]code=/.test(text)) throw { code: "account_link" };
      if (state.state !== "signingIn") throw { code: "account_state" };
      if (new URLSearchParams(text.slice(CALLBACK.length)).get("state") !== "demo") throw { code: "account_state" };
      return set(signedIn());
    },
    async xdevIdCancel() {
      return set(signedOut());
    },
    async xdevIdSignOut() {
      return set(signedOut());
    },
    async xdevIdRefresh() {
      return state;
    },
    async xdevIdReopen() {
      if (state.state !== "signingIn") throw { code: "account_state" };
      reopens += 1;
    },
    async xdevIdServer() {
      return server;
    },
    __xdevIdServerChanged(serverUrl) {
      server = serverUrl === null ? { origin: DEFAULT_SERVER, source: "default", setting: "", invalid: false } : { origin: serverUrl, source: "setting", setting: serverUrl, invalid: false };
      // A different server ends the session and any attempt, as Rust does.
      if (state.state !== "signedOut") set(signedOut());
    },
    async xdevIdManage() {
      manages += 1;
    },
    async onXdevIdChanged(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    __xdevIdExpire() {
      set({ state: "signedOut", notice: "account_expired" });
    },
    __xdevIdDeepLink() {
      if (state.state === "signingIn") set(signedIn());
    },
    __xdevIdManages: () => manages,
    __xdevIdReopens: () => reopens,
  };
}
