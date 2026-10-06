import { expect, type Page } from "@playwright/test";

export async function createTaskThroughUi(input: {
  page: Page;
  issuePrefix: string;
  agentName: string;
  title: string;
  prompt: string;
  workMode: "standard" | "planning" | "ask";
  projectName?: string;
  requireExplicitTitle?: boolean;
}) {
  // Search's public creation action exposes the explicit title field. Strict
  // native-operation fixtures use it so automatic task naming is not an extra
  // provider mutation before the operation whose permission is under test.
  const issuesUrl = input.requireExplicitTitle
    ? `/${encodeURIComponent(input.issuePrefix)}/search?scope=issues&q=${encodeURIComponent(`"${input.title}"`)}`
    : `/${encodeURIComponent(input.issuePrefix)}/issues`;
  const newTask = input.requireExplicitTitle
    ? input.page.getByRole("button", { name: "Create task from this query", exact: true })
    : input.page.getByRole("button", { name: "New Task" }).first();
  let bootstrapError: unknown;
  for (let bootstrapAttempt = 1; bootstrapAttempt <= 3; bootstrapAttempt += 1) {
    try {
      await input.page.goto(issuesUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await newTask.waitFor({ state: "visible", timeout: 20_000 });
      bootstrapError = undefined;
      break;
    } catch (error) {
      bootstrapError = error;
      if (bootstrapAttempt < 3) await input.page.waitForTimeout(1_000);
    }
  }
  if (bootstrapError) {
    throw new Error(
      `Browser bootstrap failed before task creation: ${bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError)}`,
      { cause: bootstrapError },
    );
  }
  await newTask.click();
  const dialog = input.page.getByRole("dialog", { name: "New task", exact: true });
  const titleInput = dialog.getByRole("textbox", { name: "Task title", exact: true });
  if (await titleInput.isVisible()) await titleInput.fill(input.title);
  else if (input.requireExplicitTitle) throw new Error("This title-preservation case requires a visible explicit title input");
  await dialog
    .getByRole("textbox", { name: "editable markdown", exact: true })
    .fill(input.prompt);
  if (input.workMode !== "standard") {
    await dialog.getByRole("button", { name: "Add to composer", exact: true }).click();
    await input.page.getByTestId(input.workMode === "planning" ? "composer-add-plan" : "composer-add-ask").click();
  }
  await dialog
    .getByRole("button", { name: "Select assignee", exact: true })
    .click();
  await input.page.getByRole("searchbox", { name: "Search assignees", exact: true }).fill(input.agentName);
  await input.page.getByRole("option").filter({ has: input.page.getByText(input.agentName, { exact: true }) }).click();
  await expect(input.page.getByRole("searchbox", { name: "Search assignees", exact: true })).toBeHidden();
  if (input.projectName) {
    // The selector remembers the previous project, so its visible label changes.
    await dialog.locator('button[data-slot="new-issue-compact-control"]').click();
    await input.page.getByPlaceholder("Search projects...").fill(input.projectName);
    await input.page.getByText(input.projectName, { exact: true }).last().click();
  }
  const submittedAtMs = Date.now();
  // The prompt-only composer generates a provisional title which the provider
  // can rename immediately. Bind the fixture to the actual creation response.
  const [response] = await Promise.all([
    input.page.waitForResponse(response => response.request().method() === "POST"
      && /^\/api\/companies\/[^/]+\/issues$/.test(new URL(response.url()).pathname)),
    dialog.getByRole("button", { name: "Create task", exact: true }).click(),
  ]);
  expect(response.status()).toBe(201);
  const issue = await response.json() as { id: string; companyId: string; title: string; titleNeedsGeneration: boolean };
  expect(new URL(response.url()).pathname).toBe(`/api/companies/${issue.companyId}/issues`);
  expect(issue.id).toEqual(expect.any(String));
  expect(issue.id.length).toBeGreaterThan(0);
  if (input.requireExplicitTitle) {
    expect(issue.title).toBe(input.title);
    expect(issue.titleNeedsGeneration).toBe(false);
  }
  return { submittedAtMs, issueId: issue.id };
}

export async function submitTaskReply(
  page: Page,
  body: string,
): Promise<number> {
  const composer = page.getByTestId("task-chat-composer-input").last();
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer
    .locator('[contenteditable="true"], textarea')
    .first()
    .fill(body);
  const submittedAtMs = Date.now();
  await page.getByTestId("task-chat-composer-send").last().click();
  return submittedAtMs;
}
