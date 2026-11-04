import type { Api, ApiError } from "./api";
import { LAYOUT_VERSION, type LayoutSnapshot } from "./workspace/layoutSnapshot";

/** `LAYOUT_MAX` in `layout.rs`: the largest snapshot stored, in bytes of JSON. */
export const LAYOUT_MAX = 1024 * 1024;

type LayoutApi = Pick<Api, "layoutLoad" | "layoutSave">;

/** `layout.json` in memory: the same checks as `layout.rs`, nothing on disk. */
export function createMockLayout(initial: LayoutSnapshot | null = null): LayoutApi {
  let saved: string | null = initial ? JSON.stringify(initial) : null;
  return {
    async layoutLoad() {
      return saved === null ? null : (JSON.parse(saved) as LayoutSnapshot);
    },
    async layoutSave(snapshot) {
      if ((snapshot as { version: unknown }).version !== LAYOUT_VERSION) {
        return Promise.reject({ code: "bad_arg", detail: "version" } satisfies ApiError);
      }
      const text = JSON.stringify(snapshot);
      if (new TextEncoder().encode(text).length > LAYOUT_MAX) {
        return Promise.reject({ code: "too_large" } satisfies ApiError);
      }
      saved = text;
    },
  };
}
