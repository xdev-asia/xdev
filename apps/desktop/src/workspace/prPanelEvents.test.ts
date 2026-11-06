import { expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { onPrPageOpen, onPrPanelOpen, openPrPage, openPrPanel, prPanelItems } from "./prPanelEvents";

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

it("Open pull request page asks the shell for the full page, not the panel", () => {
  const page = prPanelItems(t).find((i) => i.id === "pr-page:open")!;
  expect(page.title).toBe("Open pull request page");
  expect(page.keywords).toContain("page");
  const panel = vi.fn();
  const heard = vi.fn();
  const stopPanel = onPrPanelOpen(panel);
  const stop = onPrPageOpen(heard);
  page.run();
  expect(heard).toHaveBeenCalledTimes(1);
  expect(panel).not.toHaveBeenCalled();
  stop();
  stopPanel();
  openPrPage();
  expect(heard).toHaveBeenCalledTimes(1);
});
