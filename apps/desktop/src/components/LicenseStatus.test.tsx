import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import { LicenseStatus, statusNoticeOf } from "./StatusBar";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string) => translate("en", key) }) }));

type Node = ReactElement<Record<string, any>>;

it("shows a notice only for the clock, revoked and expired states", () => {
  for (const n of ["clock", "revoked", "expired"]) expect(statusNoticeOf(n)).toBe(n);
  for (const n of [null, "grace", "noSeat", "checkoutTimeout", "unavailable"]) expect(statusNoticeOf(n)).toBeNull();
});

it("renders nothing for a free person with no notice", () => {
  expect(LicenseStatus({ notice: null })).toBeNull();
  expect(LicenseStatus({ notice: "grace" })).toBeNull();
});

it("renders one status with a dot and a button that opens Account", () => {
  const open = vi.fn();
  const out = LicenseStatus({ notice: "expired", onOpen: open }) as Node;
  expect(out.props.role).toBe("status");
  const [button] = [out.props.children as Node];
  expect(button.type).toBe("button");
  expect(button.props.type).toBe("button");
  const [dot, text] = button.props.children as [Node, string];
  expect(dot.props["aria-hidden"]).toBe("true");
  expect(text).toBe(translate("en", "license.notice.expired.title"));
  button.props.onClick();
  expect(open).toHaveBeenCalledTimes(1);
});
