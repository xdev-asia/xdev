import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

type Mock = {
  __hook(id: string, event: string, detail?: unknown, session?: string): void;
  __ptyWritten(id: string): string;
  __conversationFixture(name: "default" | "subagents"): void;
};

/** The hook detail of a claude AskUserQuestion with three options (crates/xdev-agent/fixtures/hooks). */
const ASK = {
  toolName: "AskUserQuestion",
  message: null,
  isInterrupt: false,
  error: null,
  toolInput: null,
  question: {
    kind: "choice",
    text: "Which database should the cache use?",
    header: "Cache",
    options: [
      { label: "Redis", description: "Fast, needs a running server" },
      { label: "SQLite", description: "A file next to the app" },
      { label: "In memory", description: "Lost on restart" },
    ],
    multi: false,
    count: 1,
  },
};

/** The first-run tip card sits over the bottom-right corner. */
async function dismissTip(page: Page): Promise<void> {
  const later = page.getByRole("complementary", { name: "Tip: xDev skill" }).getByRole("button", { name: "Maybe later" });
  if (await later.waitFor({ timeout: 3_000 }).then(() => true, () => false)) await later.click();
}

/** Starts a Claude tab, gives it a session id and returns its tab id. */
async function startAgent(page: Page): Promise<string> {
  await dismissTip(page);
  await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  await page.getByRole("button", { name: "Allow and start" }).click();
  const tab = page.locator('.ws-tab[data-selected="true"]');
  await expect(tab).toBeVisible();
  const id = (await tab.getAttribute("data-tab-id"))!;
  await hook(page, id, "prompt", undefined, "sess-ask");
  return id;
}

async function hook(page: Page, id: string, event: string, detail?: unknown, session?: string): Promise<void> {
  await page.evaluate(([tab, e, d, s]) => (window as unknown as { xdevMock: Mock }).xdevMock.__hook(tab as string, e as string, d, s as string | undefined), [id, event, detail, session] as const);
}

const written = (page: Page, id: string) => page.evaluate((tab) => (window as unknown as { xdevMock: Mock }).xdevMock.__ptyWritten(tab), id);

test("a three-option question is answered from the conversation after a confirm, and the pty gets 2", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openApp();
  const id = await startAgent(page);
  await hook(page, id, "needs-input", ASK, "sess-ask");

  // The tab shows the question before the conversation is open.
  const badge = page.locator(`.ws-tab[data-tab-id="${id}"]`).getByTestId("tab-question");
  await expect(badge).toHaveText("question");

  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  const view = page.getByRole("region", { name: "Conversation of Claude Code" });
  const card = view.getByRole("group", { name: "Claude Code asks" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Which database should the cache use?");
  await expect(view.getByRole("status")).toHaveText("Claude Code asks a question");

  // Picking sends nothing; the keys are shown first.
  await card.getByRole("radio", { name: /SQLite/ }).check();
  await expect(card.locator(".cv-ask-sends kbd")).toHaveText(["2"]);
  await card.getByRole("button", { name: "Send answer" }).click();
  expect(await written(page, id)).toBe("");
  await expect(card).toContainText("Send “SQLite” to Claude Code?");
  const confirm = card.getByRole("button", { name: "Confirm and send" });
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Enter");

  await expect.poll(() => written(page, id), { timeout: 5_000 }).toBe("2");
  await expect(card).toHaveCount(0);
  await expect(badge).toHaveCount(0);
  await expect(view.getByRole("status")).toHaveText("Answer sent");
});

test("a prompt it cannot answer points to the terminal", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openApp();
  const id = await startAgent(page);
  await hook(page, id, "needs-input", { ...ASK, question: { ...ASK.question, multi: true } }, "sess-ask");
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  const view = page.getByRole("region", { name: "Conversation of Claude Code" });
  const card = view.getByTestId("question-card");
  await expect(card.getByRole("radio")).toHaveCount(0);
  await card.getByRole("button", { name: "Open terminal to answer" }).click();
  await expect(view).toHaveCount(0);
  await expect(page.locator(".xterm-helper-textarea:focus")).toHaveCount(1);
  expect(await written(page, id)).toBe("");
});

test("sub-agent runs fold under their call, list in the header, and fit at 360px", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openApp();
  await page.evaluate(() => (window as unknown as { xdevMock: Mock }).xdevMock.__conversationFixture("subagents"));
  const id = await startAgent(page);
  // The turn ended on a numbered question: the card reads it from the transcript.
  await hook(page, id, "turn-done", undefined, "sess-ask");
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  const view = page.getByRole("region", { name: "Conversation of Claude Code" });

  const count = view.getByTestId("subagent-badge");
  await expect(count).toContainText("Sub-agents");
  await expect(count).toContainText("2");
  const groups = view.getByTestId("subagent-group");
  await expect(groups).toHaveCount(2);
  const first = view.getByRole("button", { name: /Sub-agent: Find parser bugs/ });
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(view.locator(".cv-sub-body")).toHaveCount(0);
  await first.click();
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(groups.first().locator(".cv-step")).toHaveCount(1);
  await expect(groups.first()).toContainText("Reading the parser.");
  await expect(groups.first()).toContainText("is a stub.");

  // The history list opens the other run and moves the focus to it.
  await count.click();
  await expect(count).toHaveAttribute("aria-expanded", "true");
  const history = view.getByRole("navigation", { name: "Sub-agent runs" });
  await history.getByRole("button", { name: /Check the docs/ }).click();
  const second = view.getByRole("button", { name: /Sub-agent: Check the docs/ });
  await expect(second).toHaveAttribute("aria-expanded", "true");
  await expect(second).toBeFocused();

  // No CLI sends to an ended sub-agent: the follow-up goes to the composer.
  await groups.first().getByRole("button", { name: "Follow up on result" }).click();
  await expect(view.getByRole("status")).toHaveText("A follow-up is ready in the composer");

  const card = view.getByRole("group", { name: "Claude Code asks" });
  await expect(card).toContainText("Which fix should I make first?");
  await expect(card.getByRole("radio")).toHaveCount(3);

  await page.setViewportSize({ width: 360, height: 740 });
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await expect(page.getByTestId("conversation-dock")).toHaveAttribute("data-mode", "full");
  await expect(card).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await view.getByRole("button", { name: "Reader", exact: true }).click();
  await expect(view.getByTestId("subagent-group")).toHaveCount(2);
  expect(await fitsWidth(page)).toBe(true);
});
