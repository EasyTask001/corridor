import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("corridor-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("natural-language reporting", () => {
  test("translates an approved question and renders summary, chart, and table", async ({
    page,
  }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/reports");
    await page
      .getByLabel("What do you want to know?")
      .fill("How many movements by status all time?");
    await page.getByRole("button", { name: "Run report" }).click();

    await expect(page.getByRole("heading", { name: "Movement count by status" })).toBeVisible();
    await expect(page.getByText("Movement count by status for all time.")).toBeVisible();
    await expect(page.getByLabel("Movement count by status bar chart")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Result" })).toBeVisible();
    await expect(page.getByText("status: rejected")).toHaveCount(0);
  });

  test("rejects unsupported measures instead of generating an unconstrained query", async ({
    page,
  }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/reports");
    await page.getByLabel("What do you want to know?").fill("Average border wait time by driver");
    await page.getByRole("button", { name: "Run report" }).click();
    await expect(
      page.getByText("That measure is not available yet.", { exact: false }),
    ).toBeVisible();
  });

  test("executes every approved aggregate family", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/reports");

    const questions = [
      ["Show total cargo weight by crossing all time", "Cargo weight by crossing"],
      ["Show average cargo weight by regime all time", "Average cargo weight by regime"],
      ["Show piece count by status all time", "Piece count by status"],
      ["Show declared value in CAD by month all time", "Declared value by month"],
      ["Show rejection rate by regime all time", "Rejection rate by regime"],
      ["Show hold rate by crossing all time", "Hold rate by crossing"],
    ] as const;

    for (const [question, title] of questions) {
      await page.getByLabel("What do you want to know?").fill(question);
      await page.getByRole("button", { name: "Run report" }).click();
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
    }
  });

  test("Driver-Portal cannot access organization-wide reports", async ({ page }) => {
    await login(page, "driver@pathfinder.demo");
    await page.goto("/reports");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("link", { name: "Reports" })).toHaveCount(0);
  });
});
