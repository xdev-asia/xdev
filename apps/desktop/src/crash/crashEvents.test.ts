import { describe, expect, it, vi } from "vitest";
import { startCrashBreadcrumbs } from "./crashEvents";

function fakeTarget() {
  const handlers = new Map<string, (e: never) => void>();
  return {
    handlers,
    addEventListener: (type: string, cb: (e: never) => void) => void handlers.set(type, cb),
    removeEventListener: (type: string) => void handlers.delete(type),
  };
}

describe("crash breadcrumbs", () => {
  it("records an error and a rejection, and ignores resize observer noise", () => {
    const api = { crashBreadcrumb: vi.fn(async () => {}) };
    const target = fakeTarget();
    const stop = startCrashBreadcrumbs(api, target);
    const fire = (type: string, e: object) => (target.handlers.get(type) as (e: object) => void)(e);
    fire("error", { message: "ResizeObserver loop completed with undelivered notifications." });
    expect(api.crashBreadcrumb).not.toHaveBeenCalled();
    fire("error", { message: "x is not a function" });
    fire("unhandledrejection", { reason: new Error("nope") });
    fire("unhandledrejection", { reason: "plain" });
    expect(api.crashBreadcrumb.mock.calls).toEqual([
      ["renderer_error", [{ key: "message", value: "x is not a function" }]],
      ["renderer_unhandled_rejection", [{ key: "message", value: "nope" }]],
      ["renderer_unhandled_rejection", [{ key: "message", value: "plain" }]],
    ]);
    stop();
    expect(target.handlers.size).toBe(0);
  });
});
