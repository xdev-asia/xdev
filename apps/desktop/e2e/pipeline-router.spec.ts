import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

type Mock = { __pipelineExits(codes: number[]): void; __swarmOpened(): string[] };
const mock = <T>(page: Page, call: (m: Mock) => T) => page.evaluate(`(${call.toString()})(window.xdevMock)`) as Promise<T>;

/** The first-run tip floats over the corner of the page; the specs dismiss it as the others do. */
const dismissTip = async (page: Page) => {
  const later = page.getByRole("complementary", { name: "Tip: xDev skill" }).getByRole("button", { name: "Maybe later" });
  if (await later.isVisible()) await later.click();
};

/** The Squads page of the first squad (idle, with no run). */
const openSquad = async (page: Page) => {
  await dismissTip(page);
  await page.getByRole("button", { name: "Docs & SDLC" }).click();
  await page.getByRole("button", { name: /^Squads/ }).first().click();
  await expect(page.getByRole("heading", { name: "Bug squad" })).toBeVisible();
};

const stage = (page: Page, name: string) => page.getByRole("list", { name: "Stages of Ship the goal" }).getByRole("listitem").filter({ hasText: name });

test("a three-stage run: stage 2 fails its gate and stays put, then a confirmed retry passes", async ({ page, openApp }) => {
  await openApp();
  await openSquad(page);
  const pipeline = page.getByRole("region", { name: "Pipeline", exact: true });
  await pipeline.getByRole("textbox", { name: "Check command for tests" }).fill("cargo test");
  await pipeline.getByRole("button", { name: "Start pipeline" }).click();
  await expect(pipeline.getByRole("status")).toHaveText("Ship the goal started.");
  await expect(stage(page, "Implement")).toContainText("Running");
  await expect(stage(page, "Tests")).toContainText("Check: cargo test");
  await expect(stage(page, "Review")).toContainText("Needs your approval");

  await pipeline.getByRole("button", { name: "Hand off" }).click();
  await expect(stage(page, "Implement")).toContainText("Passed");
  await expect(stage(page, "Tests")).toContainText("Running");

  // The check fails once: the stage stays put and says why.
  await mock(page, (m) => m.__pipelineExits([1]));
  await pipeline.getByRole("button", { name: "Hand off" }).click();
  await expect(stage(page, "Tests")).toContainText("Gate failed");
  await expect(stage(page, "Tests")).toContainText("Why: cargo exit 1: 1 test failed");
  await expect(stage(page, "Review")).toContainText("Pending");
  await expect(pipeline.getByRole("status")).toContainText("Tests stays put.");

  // Retry asks first; cancelling changes nothing.
  await pipeline.getByRole("button", { name: "Retry" }).click();
  const dialog = page.getByRole("dialog", { name: "Retry this stage?" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(stage(page, "Tests")).toContainText("Gate failed");
  await pipeline.getByRole("button", { name: "Retry" }).click();
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(stage(page, "Tests")).toContainText("Passed");
  await expect(stage(page, "Review")).toContainText("Running");
  await expect(pipeline.getByRole("status")).toContainText("Tests passed. Review is next.");

  // The review is a person's approval: approving confirms first and finishes the run.
  await pipeline.getByRole("button", { name: "Hand off" }).click();
  await expect(stage(page, "Review")).toContainText("Needs approval");
  await pipeline.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("dialog", { name: "Approve this stage?" }).getByRole("button", { name: "Approve" }).click();
  await expect(stage(page, "Review")).toContainText("Passed");
  await expect(pipeline.getByRole("status")).toHaveText("Ship the goal is done.");
});

test("the router's test box says which row takes a sentence, and the default row otherwise", async ({ page, openApp }) => {
  await openApp();
  await dismissTip(page);
  await page.getByRole("button", { name: "Docs & SDLC" }).click();
  await page.getByRole("button", { name: /^Accounts/ }).first().click();
  const routing = page.getByRole("region", { name: "Model routing" });
  await routing.scrollIntoViewIfNeeded();
  await routing.getByRole("button", { name: "Add row" }).click();
  const first = routing.getByRole("group", { name: "Row 1" });
  await first.getByLabel("Keywords").fill("fix typo, rename");
  await first.getByLabel("Agent").selectOption("codex");
  await first.getByLabel("Model").fill("gpt-mini");
  await routing.getByRole("button", { name: "Add row" }).click();
  const second = routing.getByRole("group", { name: "Row 2" });
  await second.getByLabel("Keywords").fill("refactor, rename");
  await second.getByLabel("Model").fill("opus");

  const box = routing.getByRole("form", { name: "Test a sentence" });
  await box.getByLabel("Test a sentence").fill("Please rename the helper");
  await box.getByRole("button", { name: "Test" }).click();
  // Both rows match "rename"; the first wins.
  await expect(routing.locator(".routing-match")).toHaveText("Row 1 takes it: codex · gpt-mini.");

  // Alt+ArrowUp in the second row moves it above the first, and the same sentence now goes to it.
  await second.getByLabel("Keywords").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(routing.getByRole("group", { name: "Row 1" }).getByLabel("Keywords")).toHaveValue("refactor, rename");
  await expect(routing.getByRole("group", { name: "Row 1" }).getByLabel("Keywords")).toBeFocused();
  await box.getByRole("button", { name: "Test" }).click();
  await expect(routing.locator(".routing-match")).toHaveText("Row 1 takes it: claude · opus.");

  await box.getByLabel("Test a sentence").fill("write a poem");
  await box.getByRole("button", { name: "Test" }).click();
  await expect(routing.locator(".routing-match")).toHaveText("No row matches. The default row takes it: claude.");

  await routing.getByRole("button", { name: "Save rules" }).click();
  await expect(routing.getByText("Saved. New turns use these rules.")).toBeVisible();
});

test("a swarm of 3 runs hidden, lists progress, and one worker opens as a tab; stop all asks first", async ({ page, openApp }) => {
  await openApp();
  await openSquad(page);
  const swarm = page.getByRole("region", { name: "Swarm", exact: true });
  await expect(swarm.getByRole("spinbutton", { name: "Workers" })).toHaveValue("4");
  await swarm.getByLabel("Goal").fill("Port the parser");
  await swarm.getByRole("spinbutton", { name: "Workers" }).fill("3");
  await swarm.getByRole("button", { name: "Start swarm" }).click();
  await expect(swarm.getByRole("status")).toHaveText("3 workers started.");
  const list = swarm.getByRole("list", { name: "Swarm workers" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list.getByRole("listitem", { name: "Worker 1" })).toContainText("Working on part 1 of 3");
  await expect(swarm.getByText("3 of 3 workers running")).toBeVisible();

  await swarm.getByRole("button", { name: "Open Worker 2 as a tab" }).click();
  await expect(list.getByRole("listitem", { name: "Worker 2" })).toContainText("Opened");
  await expect(list.getByRole("listitem", { name: "Worker 1" })).not.toContainText("Opened");
  expect(await mock(page, (m) => m.__swarmOpened())).toHaveLength(1);

  await swarm.getByRole("button", { name: "Stop all" }).click();
  const dialog = page.getByRole("dialog", { name: "Stop all workers?" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(swarm.getByText("3 of 3 workers running")).toBeVisible();
  await swarm.getByRole("button", { name: "Stop all" }).click();
  await dialog.getByRole("button", { name: "Stop all" }).click();
  await expect(swarm.getByRole("status")).toHaveText("3 workers stopped.");
  await expect(swarm.getByText("0 of 3 workers running")).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
