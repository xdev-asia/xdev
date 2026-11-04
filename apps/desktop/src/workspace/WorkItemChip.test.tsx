import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { WorkItemChip } from "./WorkItemChip";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

it("work item chip shows the number or host and copies the url on click", () => {
  const copied: string[] = [];
  const el = WorkItemChip({ item: { kind: "pr", url: "https://x.test/o/r/pull/42", title: null }, onCopy: (u) => copied.push(u) }) as ReactElement<Record<string, any>>;
  expect(renderToStaticMarkup(el)).toContain("#42");
  el.props.onClick({ stopPropagation() {} });
  expect(copied).toEqual(["https://x.test/o/r/pull/42"]);
  el.props.onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
  expect(copied).toHaveLength(2);
  const host = WorkItemChip({ item: { kind: "issue", url: "https://x.test/board", title: null }, onCopy() {} });
  expect(renderToStaticMarkup(host)).toContain("x.test");
});
