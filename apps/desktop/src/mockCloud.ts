import type { CloudSettings } from "@xdev/bindings";
import type { Api, ApiError } from "./api";

type CloudApi = Pick<Api, "cloudSettings" | "cloudSettingsPut">;

const DEFAULT_SERVER = "https://id.xdev.asia";

function reject(code: ApiError["code"]): Promise<never> {
  const error: ApiError = { code };
  return Promise.reject(error);
}

/** The origin Rust accepts: https, or http to loopback; no path, query or user info. */
function origin(value: string): string | null {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const scheme = url.protocol === "https:" || (url.protocol === "http:" && loopback);
    const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
    return scheme && bare ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Settings → Cloud in memory. A different server calls `onServerChange`, as Rust signs out of
 * xDev ID and drops the cached license there.
 */
export function createMockCloud(onServerChange: () => void = () => undefined): CloudApi {
  let stored: CloudSettings = { serverUrl: null, pinnedRoots: [] };
  return {
    cloudSettings: () => Promise.resolve(structuredClone(stored)),
    cloudSettingsPut(settings) {
      const raw = settings.serverUrl?.trim() ?? "";
      let serverUrl: string | null = null;
      if (raw !== "") {
        const o = origin(raw);
        if (o === null) return reject("cloud_bad_url");
        serverUrl = o === DEFAULT_SERVER ? null : o;
      }
      const roots = [...new Set(settings.pinnedRoots.map((r) => r.trim()).filter((r) => r !== ""))];
      if (roots.some((r) => !/^[A-Za-z0-9+/_-]{20,}={0,2}$/.test(r))) return reject("cloud_bad_root");
      if (serverUrl !== null && roots.length === 0) return reject("cloud_need_root");
      const next: CloudSettings = { serverUrl, pinnedRoots: serverUrl === null ? [] : roots };
      const moved = next.serverUrl !== stored.serverUrl;
      stored = next;
      if (moved) onServerChange();
      return Promise.resolve(structuredClone(stored));
    },
  };
}
