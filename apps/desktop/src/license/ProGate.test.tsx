import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Badge, Button } from "@xdev-asia/ui";
import { translate } from "@/i18n";

const license = vi.hoisted(() => ({ allowed: false, upsell: vi.fn() }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useContext: () => license.upsell }));
vi.mock("./useLicense", () => ({ useLicense: () => ({ allows: () => license.allowed }) }));
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string) => translate("en", key) }) }));

import { ProGate } from "./ProGate";

type Node = ReactElement<Record<string, any>>;

it("renders the children when the license allows the feature", () => {
  license.allowed = true;
  const out = ProGate({ feature: "pro.phone", children: "inside" }) as Node;
  expect(out.props.children).toBe("inside");
});

it("renders the fallback when given, in place of the default", () => {
  license.allowed = false;
  const out = ProGate({ feature: "pro.phone", children: "inside", fallback: "locked" }) as Node;
  expect(out.props.children).toBe("locked");
});

it("by default renders a secondary Pro button that opens the upsell for the feature", () => {
  license.allowed = false;
  license.upsell.mockClear();
  const out = ProGate({ feature: "pro.phone", children: "inside" }) as Node;
  expect(out.type).toBe(Button);
  expect(out.props.variant).toBe("secondary");
  expect(out.props.type).toBe("button");
  expect((out.props.children as Node).type).toBe(Badge);
  out.props.onClick();
  expect(license.upsell).toHaveBeenCalledWith("pro.phone");
});
