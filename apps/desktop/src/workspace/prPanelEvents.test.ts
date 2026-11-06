import { expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { onPrPanelOpen, openPrPanel, prPanelItems } from "./prPanelEvents";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

it("the palette command is Open pull request and asks the shell to open the panel", () => {
  const [item] = prPanelItems(t);
  expect(item.title).toBe("Open pull request");
  expect(item.keywords).toContain("pr");
  const heard = vi.fn();
  const stop = onPrPanelOpen(heard);
  item.run();
  expect(heard).toHaveBeenCalledTimes(1);
  stop();
  openPrPanel();
  expect(heard).toHaveBeenCalledTimes(1);
});
