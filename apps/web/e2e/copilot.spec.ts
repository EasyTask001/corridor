import { expect, test, type Page } from "@playwright/test";

/**
 * Compliance copilot — requires local Supabase + `pnpm db:seed` (the seed
 * ingests the regulation corpus the citations point at).
 *
 * Works in both modes: with an AI key the answer comes from the model, without
 * one the chat route streams a mock summary. Retrieval — and therefore the
 * citation chips — runs either way, so the assertions below hold in both.
 */

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("corridor-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("compliance copilot", () => {
  test("answers a regulation question with a citation to the seeded corpus", async ({ page }) => {
    test.slow(); // model streaming + first-hit compilation of the chat route
    await login(page, "compliance@pathfinder.demo");

    await page.getByRole("link", { name: "Copilot" }).click();
    await expect(page).toHaveURL(/\/copilot/);
    await expect(page.getByRole("heading", { name: "Compliance copilot" })).toBeVisible();

    await page
      .getByLabel("Ask the copilot")
      .fill("What documents are required for an ACE e-manifest?");
    await page.getByRole("button", { name: "Send" }).click();

    const assistant = page.locator('[data-message-role="assistant"]').first();
    await expect(assistant).toBeVisible({ timeout: 90_000 });

    // Citations arrive as a data part before the text, and render as a source list.
    await expect(assistant.getByText("Sources")).toBeVisible({ timeout: 90_000 });
    await expect(
      assistant.getByRole("link", { name: /Advance Electronic Truck Cargo Manifest/ }),
    ).toBeVisible();

    // …and an actual streamed answer, not just the citation block.
    await expect(page.getByText("Thinking…")).toHaveCount(0, { timeout: 90_000 });
    expect(
      (await assistant.innerText()).replace(/Sources[\s\S]*$/, "").trim().length,
    ).toBeGreaterThan(20);
  });

  test("a user without copilot.use gets the not-available state, not an error", async ({
    page,
  }) => {
    await login(page, "readonly@pathfinder.demo");

    await expect(page.getByRole("link", { name: "Copilot" })).toHaveCount(0);

    await page.goto("/copilot");
    await expect(page.getByRole("heading", { name: "Compliance copilot" })).toBeVisible();
    await expect(page.getByText("not available for your role", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Ask the copilot")).toHaveCount(0);
  });
});
