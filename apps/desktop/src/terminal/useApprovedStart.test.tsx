import { beforeEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { PtyClient } from "./ptyClient";
import { useApprovedStart } from "./useApprovedStart";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  // The profile store is outside what these tests render; its context keeps the default.
  useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] = value;
      },
    ];
  },
}));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function setup() {
  const api = createMockApi({});
  const draw = () => {
    hooks.cursor = 0;
    return useApprovedStart(api);
  };
  const client = new PtyClient(api, "t-1");
  const start = () => draw().start(client, "/demo", "claude", 80, 24, () => {});
  const dialog = () => draw().dialog.props as { open: boolean; onConfirm(): void; onCancel(): void };
  return { api, draw, start, dialog };
}
beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
});

it("starts straight away when no approval is needed", async () => {
  const s = setup();
  await s.api.ptyApprove("claude", null);
  expect(await s.start()).toMatchObject({ id: "t-1", agent: true });
  expect(s.dialog().open).toBe(false);
});

it("asks once, approves, then starts again", async () => {
  const s = setup();
  const approve = vi.spyOn(s.api, "ptyApprove");
  const started = s.start();
  await tick();
  expect(s.dialog().open).toBe(true);
  s.dialog().onConfirm();
  expect(await started).toMatchObject({ id: "t-1" });
  expect(approve).toHaveBeenCalledWith("claude", null);
  expect(s.dialog().open).toBe(false);
});

it("resolves null when the question is declined", async () => {
  const s = setup();
  const started = s.start();
  await tick();
  s.dialog().onCancel();
  expect(await started).toBeNull();
  expect(s.dialog().open).toBe(false);
});

it("shows any other failure as the error and resolves null", async () => {
  const s = setup();
  vi.spyOn(s.api, "ptySpawn").mockRejectedValue({ code: "pty_spawn", detail: "boom" });
  expect(await s.start()).toBeNull();
  expect(s.draw().error).toEqual({ code: "pty_spawn", detail: "boom" });
});

it("approves a fork launch with the same resume id and fork", async () => {
  const s = setup();
  const approve = vi.spyOn(s.api, "ptyApprove");
  const client = new PtyClient(s.api, "t-3", "abc-1", true);
  const started = s.draw().start(client, "/demo", "claude", 80, 24, () => {}, null, "abc-1", true);
  await tick();
  s.dialog().onConfirm();
  expect(await started).toMatchObject({ id: "t-3" });
  expect(approve).toHaveBeenCalledWith("claude", null, "abc-1", true);
});

it("approves a resume launch with the same resume id", async () => {
  const s = setup();
  const approve = vi.spyOn(s.api, "ptyApprove");
  const client = new PtyClient(s.api, "t-2", "abc-1");
  const started = s.draw().start(client, "/demo", "claude", 80, 24, () => {}, null, "abc-1");
  await tick();
  s.dialog().onConfirm();
  expect(await started).toMatchObject({ id: "t-2" });
  expect(approve).toHaveBeenCalledWith("claude", null, "abc-1");
});
