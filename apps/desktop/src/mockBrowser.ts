import type { Api, ApiError, BrowserBounds, BrowserPage, BrowserSettings, BrowserTabUrl, ErrorCode } from "./api";

type BrowserApi = Pick<
  Api,
  | "browserShow"
  | "browserSetBounds"
  | "browserHide"
  | "browserClose"
  | "browserNavigate"
  | "browserHistory"
  | "browserReload"
  | "browserDevtools"
  | "browserSettings"
  | "browserSettingsPut"
  | "onBrowserPage"
  | "onBrowserEvicted"
  | "onBrowserPopup"
>;

export type MockBrowser = BrowserApi & {
  /** Tabs with a live fake webview, least recently shown first. */
  __browserLive(): string[];
  /** Where each live fake webview sits, or null while it is hidden. */
  __browserBounds(tab: string): BrowserBounds | null;
  /** The page of `tab` opens a new window at `url`: emits `browser://popup`. */
  __browserPopup(tab: string, url: string): void;
};

export type MockBrowserOptions = {
  /** `?browser=unavailable`: the platform cannot make a webview (as on a Linux without WebKitGTK). */
  unavailable?: boolean;
};

const MAX_LIVE = 3;
const DEFAULTS: BrowserSettings = { openLinksIn: "system", searchTemplate: "" };

function reject(code: ErrorCode): Promise<never> {
  const error: ApiError = { code };
  return Promise.reject(error);
}

export function browserOptionsFromLocation(): MockBrowserOptions {
  if (typeof location === "undefined") return {};
  return { unavailable: new URLSearchParams(location.search).get("browser") === "unavailable" };
}

/** A small stand-in for `normalize_address` in `browser_pane/address.rs`; the backend is the rule. */
function normalize(input: string, template: string): string | ErrorCode {
  const text = input.trim();
  if (!text) return "browser_empty";
  if (text.toLowerCase() === "about:blank") return "about:blank";
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d+(?:[/?#]|$))/i.exec(text)?.[1]?.toLowerCase();
  if (scheme) return scheme === "http" || scheme === "https" ? text : "browser_scheme";
  const host = text.split(/[/?#]/)[0].split(":")[0].toLowerCase();
  const search = /\s/.test(text) || (!host.includes(".") && host !== "localhost");
  if (search && template.trim()) return template.replace("%s", encodeURIComponent(text));
  if (host === "localhost" || host.endsWith(".localhost") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return `http://${text}`;
  return `https://${text}`;
}

/** The browser commands in memory: no page loads, the fake webviews only remember where they sit. */
export function createMockBrowser(options: MockBrowserOptions = {}): MockBrowser {
  let settings: BrowserSettings = { ...DEFAULTS };
  const live: string[] = [];
  const urls = new Map<string, string>();
  const bounds = new Map<string, BrowserBounds | null>();
  const page = new Set<(e: BrowserPage) => void>();
  const evicted = new Set<(e: BrowserTabUrl) => void>();
  const popup = new Set<(e: BrowserTabUrl) => void>();
  const on =
    <E>(set: Set<(e: E) => void>) =>
    (cb: (e: E) => void): Promise<() => void> => {
      set.add(cb);
      return Promise.resolve(() => void set.delete(cb));
    };
  const loaded = (tab: string) => {
    const url = urls.get(tab) ?? "about:blank";
    queueMicrotask(() => page.forEach((cb) => cb({ tab, url, loading: false, title: url })));
  };

  return {
    browserShow(tab, url, b) {
      if (options.unavailable) return reject("browser_unavailable");
      if (!live.includes(tab)) {
        urls.set(tab, url);
        loaded(tab);
      }
      const at = live.indexOf(tab);
      if (at >= 0) live.splice(at, 1);
      live.push(tab);
      bounds.set(tab, b.width >= 1 && b.height >= 1 ? b : null);
      for (const gone of live.splice(0, Math.max(0, live.length - MAX_LIVE))) {
        const e = { tab: gone, url: urls.get(gone) ?? "about:blank" };
        bounds.delete(gone);
        evicted.forEach((cb) => cb(e));
      }
      return Promise.resolve();
    },
    browserSetBounds(tab, b) {
      if (live.includes(tab)) bounds.set(tab, b.width >= 1 && b.height >= 1 ? b : null);
      return Promise.resolve();
    },
    browserHide(tab) {
      if (live.includes(tab)) bounds.set(tab, null);
      return Promise.resolve();
    },
    browserClose(tab) {
      const at = live.indexOf(tab);
      if (at >= 0) live.splice(at, 1);
      bounds.delete(tab);
      urls.delete(tab);
      return Promise.resolve();
    },
    browserNavigate(tab, input) {
      const url = normalize(input, settings.searchTemplate);
      // Error codes have no colon; every address does.
      if (!url.includes(":")) return reject(url as ErrorCode);
      if (live.includes(tab)) {
        urls.set(tab, url);
        loaded(tab);
      }
      return Promise.resolve(url);
    },
    browserHistory: () => Promise.resolve(),
    browserReload(tab) {
      if (live.includes(tab)) loaded(tab);
      return Promise.resolve();
    },
    browserDevtools: () => Promise.resolve(),
    browserSettings: () => Promise.resolve({ ...settings }),
    browserSettingsPut(v) {
      const t = v.searchTemplate.trim();
      if (t && (!t.includes("%s") || !/^https?:\/\/[^/]/i.test(t))) return reject("browser_template");
      settings = { openLinksIn: v.openLinksIn, searchTemplate: t };
      return Promise.resolve({ ...settings });
    },
    onBrowserPage: on(page),
    onBrowserEvicted: on(evicted),
    onBrowserPopup: on(popup),
    __browserLive: () => [...live],
    __browserBounds: (tab) => bounds.get(tab) ?? null,
    __browserPopup: (tab, url) => popup.forEach((cb) => cb({ tab, url })),
  };
}
